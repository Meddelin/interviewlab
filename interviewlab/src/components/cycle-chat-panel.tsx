// Cycle chat side panel — M11 Phase A (feature-cycle-chat.md §2).
//
// A slide-out, resizable, collapsible RIGHT panel mounted in cycle-detail.tsx OUTSIDE the
// Tabs, so it stays available over Overview / Interviews / Synthesis / Diff. Grounded
// streaming Q&A: the assistant streams a markdown answer (rendered with Streamdown, which
// safely renders incomplete markdown mid-stream) grounded in the cycle's synthesis /
// summaries / diff, with clickable citation chips back to the interview editor / finding.
//
// Runtime: assistant-ui's useExternalStoreRuntime — WE own the messages array (React state
// mirroring the DB thread, fed by the chat://<thread_id> Tauri-events stream) and provide
// onNew (send) / onCancel (stop) / onReload (regenerate). The conversation is rendered with
// our own Linear-styled list + Streamdown (per spec, Streamdown replaces the default
// markdown renderer for the assistant turn). // ponytail: no tool-call UIs — tools are
// Phase B/C; we render the streamed answer + citations only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import {
  ArrowUp,
  Check,
  ChevronDown,
  MessageSquarePlus,
  Pencil,
  PanelRightClose,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cycleChatAppend,
  cycleChatCancel,
  cycleChatSend,
  onChatEvent,
  type ChatCitation,
  type ChatMessage,
} from "@/lib/tauri";
import {
  chatKeys,
  useChatMessages,
  useChatThreads,
  useCreateChatThread,
  useDeleteChatThread,
  useRenameChatThread,
} from "@/lib/chat-queries";
import { useInterviews } from "@/lib/interview-queries";
import { useQueryClient } from "@tanstack/react-query";
import { useUiStore } from "@/lib/ui-store";
import { mod } from "@/lib/platform";

// Suggested starter questions for the empty state (mirrors the synthesis-tab empty state).
const STARTERS = [
  "Summarize the top objections in this cycle",
  "What did designers say about onboarding?",
  "What changed vs the previous wave?",
  "Which interviews mention pricing?",
];

// A live message: persisted rows + the in-flight streaming assistant buffer.
type LiveMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  streaming?: boolean;
  error?: string | null;
};

function parseCitations(json: string): ChatCitation[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ChatCitation[]) : [];
  } catch {
    return [];
  }
}

function toLive(m: ChatMessage): LiveMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    citations: parseCitations(m.citations_json),
    error: m.error,
  };
}

export function CycleChatPanel({ cycleId }: { cycleId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setChatOpen = useUiStore((s) => s.setChatOpen);

  const { data: threads, isPending: threadsPending } = useChatThreads(cycleId);
  const createThread = useCreateChatThread(cycleId);
  const renameThread = useRenameChatThread(cycleId);
  const deleteThread = useDeleteChatThread(cycleId);
  const { data: interviews } = useInterviews(cycleId);

  // The selected thread. Defaults to the newest; cleared selection means "empty / new".
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (threadId && threads?.some((t) => t.id === threadId)) return;
    setThreadId(threads && threads.length > 0 ? threads[0].id : null);
  }, [threads, threadId]);

  const { data: persisted } = useChatMessages(threadId ?? undefined);

  // The live message list = persisted history + an in-flight streaming buffer.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamBuf, setStreamBuf] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  // The thread whose turn is currently streaming. send() sets this BEFORE it sets
  // threadId (when creating a thread), so the reset effect below can tell a genuine
  // user thread-switch from the threadId change a fresh-thread send causes.
  const runningThreadRef = useRef<string | null>(null);

  // Reset the streaming buffer when the user switches to a DIFFERENT thread — but never
  // when threadId just changed because a send created a new thread (that would tear down
  // the in-flight subscription).
  useEffect(() => {
    if (threadId && threadId === runningThreadRef.current) return;
    setStreamingId(null);
    setStreamBuf("");
    setIsRunning(false);
    setError(null);
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, [threadId]);

  const messages: LiveMessage[] = useMemo(() => {
    const base = (persisted ?? []).map(toLive);
    if (streamingId && isRunning) {
      base.push({
        id: streamingId,
        role: "assistant",
        content: streamBuf,
        citations: [],
        streaming: true,
      });
    }
    return base;
  }, [persisted, streamingId, streamBuf, isRunning]);

  // Send a turn: ensure a thread, persist the user message, subscribe to the stream,
  // then invoke cycle_chat_send. Tokens append to streamBuf; done refreshes the history.
  async function send(text: string) {
    const clean = text.trim();
    if (!clean || isRunning) return;
    setError(null);

    let tid = threadId;
    if (!tid) {
      const t = await createThread.mutateAsync(undefined);
      tid = t.id;
    }
    // Mark this thread as the streaming one BEFORE setThreadId, so the reset effect
    // (which fires on the threadId change) doesn't tear down our subscription.
    runningThreadRef.current = tid;
    if (tid !== threadId) setThreadId(tid);

    // Persist the user message + seed the cache so it appears immediately.
    await cycleChatAppend(tid, clean);
    await qc.invalidateQueries({ queryKey: chatKeys.messages(tid) });

    // Set up the in-flight assistant buffer + subscribe BEFORE sending so no token is lost.
    const localStreamId = "streaming-" + Date.now();
    setStreamingId(localStreamId);
    setStreamBuf("");
    setIsRunning(true);

    const threadForEvents = tid;
    unlistenRef.current?.();
    unlistenRef.current = onChatEvent(threadForEvents, (e) => {
      if (e.kind === "token") {
        setStreamBuf((b) => b + e.text);
      } else if (e.kind === "done") {
        setIsRunning(false);
        setStreamingId(null);
        setStreamBuf("");
        runningThreadRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
        qc.invalidateQueries({ queryKey: chatKeys.messages(threadForEvents) });
        qc.invalidateQueries({ queryKey: chatKeys.threads(cycleId) });
      } else if (e.kind === "error") {
        setIsRunning(false);
        setStreamingId(null);
        setStreamBuf("");
        runningThreadRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
        if (e.message !== "cancelled") setError(e.message);
        qc.invalidateQueries({ queryKey: chatKeys.messages(threadForEvents) });
      }
    });

    try {
      await cycleChatSend(threadForEvents, cycleId, clean);
    } catch (err) {
      setIsRunning(false);
      setStreamingId(null);
      runningThreadRef.current = null;
      setError(String(err));
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  async function stop() {
    if (threadId) await cycleChatCancel(threadId);
    setIsRunning(false);
    setStreamingId(null);
    setStreamBuf("");
    runningThreadRef.current = null;
    unlistenRef.current?.();
    unlistenRef.current = null;
  }

  // --- assistant-ui useExternalStoreRuntime wiring --------------------------------
  // We own the messages array; assistant-ui's runtime drives send/stop/regenerate. The
  // conversation itself is rendered by our Linear-styled list below (Streamdown for the
  // assistant turn), so we keep the runtime contract but full styling control.
  const convertMessage = (m: LiveMessage): ThreadMessageLike => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  });
  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage,
    onNew: async (msg: AppendMessage) => {
      const text = msg.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      await send(text);
    },
    onCancel: stop,
    // Regenerate: re-run the most recent user turn (assistant-ui's onReload). Phase A keeps
    // it simple — re-send the last user message; the new answer appends a fresh turn.
    onReload: async () => {
      if (isRunning) return;
      const lastUser = [...(persisted ?? [])]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUser) await send(lastUser.content);
    },
  });

  // Cleanup on unmount.
  useEffect(() => () => unlistenRef.current?.(), []);

  // Title lookup for interview citations.
  const interviewTitle = (id: string) =>
    interviews?.find((i) => i.id === id)?.title ?? "Interview";

  function openCitation(c: ChatCitation) {
    if (c.kind === "finding") {
      // Route to the Synthesis tab + scroll to the finding (the tab reads the hash).
      navigate(`/cycles/${cycleId}#finding-${c.finding_id}`);
    } else {
      navigate(`/cycles/${cycleId}/interviews/${c.interview_id}`);
    }
  }

  const activeThread = threads?.find((t) => t.id === threadId) ?? null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col bg-card/30">
        {/* Header: thread switcher (switch / new / rename / delete) + close. */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
          <ThreadSwitcher
            threads={threads}
            pending={threadsPending}
            threadId={threadId}
            activeTitle={activeThread?.title ?? ""}
            onSelect={setThreadId}
            onNew={async () => {
              const t = await createThread.mutateAsync(undefined);
              setThreadId(t.id);
            }}
            onRename={(id, title) => renameThread.mutate({ threadId: id, title })}
            onDelete={(id) => {
              // ponytail: reuse the codebase's existing window.confirm guard (same
              // pattern as guides.tsx) instead of pulling in an AlertDialog.
              const t = threads?.find((x) => x.id === id);
              const label = t?.title?.trim() || "this chat";
              if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
              deleteThread.mutate(id);
              // Switch to the next remaining thread (newest), else empty state.
              if (id === threadId) {
                const next = threads?.find((x) => x.id !== id);
                setThreadId(next ? next.id : null);
              }
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => setChatOpen(cycleId, false)}
                aria-label="Close chat panel"
              >
                <PanelRightClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Close ({mod("J")})</TooltipContent>
          </Tooltip>
        </div>

        {/* Conversation. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {messages.length === 0 ? (
            <EmptyState onPick={send} />
          ) : (
            <ul className="flex flex-col gap-4">
              {messages.map((m) => (
                <li key={m.id}>
                  {m.role === "user" ? (
                    <UserBubble content={m.content} />
                  ) : (
                    <AssistantBubble
                      content={m.content}
                      citations={m.citations}
                      streaming={m.streaming}
                      interviewTitle={interviewTitle}
                      onOpenCitation={openCitation}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div className="mt-3 rounded-md border border-status-error/40 bg-status-error/5 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}
        </div>

        {/* Composer. */}
        <Composer isRunning={isRunning} onSend={send} onStop={stop} />
      </div>
    </AssistantRuntimeProvider>
  );
}

// --- thread switcher ----------------------------------------------------------
//
// ponytail: the old switcher paired a Radix Select with separate pencil/trash icons —
// clicking the Select highlighted+checkmarked an item but the slide-out panel swallowed
// the change, so it read as a dead click. Replaced with ONE clear dropdown menu (Popover):
// the trigger shows the current thread title + caret; opening lists every thread for the
// cycle (newest first, current checkmarked), plus inline Rename/Delete per row and a
// "＋ New chat" footer. Every click now switches, opens, renames, deletes, or creates —
// no recolor-without-action.

function ThreadSwitcher({
  threads,
  pending,
  threadId,
  activeTitle,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  threads: { id: string; title: string }[] | undefined;
  pending: boolean;
  threadId: string | null;
  activeTitle: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The thread row currently being renamed inline (id), if any.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  if (pending) {
    return <Skeleton className="h-7 flex-1" />;
  }

  const hasThreads = !!threads && threads.length > 0;
  const triggerLabel = threadId
    ? activeTitle.trim() || "Untitled chat"
    : hasThreads
      ? "Select a chat"
      : "Chat about this cycle";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setRenamingId(null); // never leave a row stuck in edit mode.
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-xs font-medium text-foreground hover:bg-secondary/60"
          aria-label="Switch chat thread"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Chats in this cycle
        </div>
        {hasThreads ? (
          <ul className="max-h-72 overflow-y-auto">
            {threads!.map((t) =>
              renamingId === t.id ? (
                <li key={t.id} className="px-0.5 py-0.5">
                  <RenameRow
                    initial={t.title}
                    onCancel={() => setRenamingId(null)}
                    onSave={(title) => {
                      onRename(t.id, title);
                      setRenamingId(null);
                    }}
                  />
                </li>
              ) : (
                <li key={t.id} className="group/row flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(t.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-secondary/70 aria-[current=true]:bg-secondary/50"
                    aria-current={t.id === threadId}
                  >
                    <Check
                      className={`size-3.5 shrink-0 ${
                        t.id === threadId
                          ? "text-primary"
                          : "text-transparent"
                      }`}
                    />
                    <span className="truncate">
                      {t.title.trim() || "Untitled chat"}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setRenamingId(t.id)}
                      aria-label={`Rename ${t.title || "chat"}`}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-status-error"
                      onClick={() => onDelete(t.id)}
                      aria-label={`Delete ${t.title || "chat"}`}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No chats yet. Start one below.
          </p>
        )}
        <div className="mt-1 border-t border-border/60 pt-1">
          <button
            type="button"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-secondary/70"
          >
            <MessageSquarePlus className="size-3.5 shrink-0 text-muted-foreground" />
            New chat
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Inline rename row used inside the switcher dropdown. Enter / check saves, Esc / X cancels.
function RenameRow({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const t = draft.trim();
        if (t) onSave(t);
        else onCancel();
      }}
    >
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-7 text-xs"
        placeholder="Chat name"
      />
      <Button type="submit" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Save name">
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onCancel}
        aria-label="Cancel rename"
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}

// --- empty state --------------------------------------------------------------

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="flex flex-col gap-4 pt-6">
      <p className="text-sm text-muted-foreground">
        Ask anything about this cycle — answers are grounded in its synthesis,
        per-interview summaries, and diff, with citations back to the source.
      </p>
      <div className="flex flex-col gap-2">
        {STARTERS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="w-fit rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:border-border-strong hover:bg-secondary"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- message bubbles ----------------------------------------------------------

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm bg-secondary/70 px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  citations,
  streaming,
  interviewTitle,
  onOpenCitation,
}: {
  content: string;
  citations: ChatCitation[];
  streaming?: boolean;
  interviewTitle: (id: string) => string;
  onOpenCitation: (c: ChatCitation) => void;
}) {
  // Strip the inline [[…]] tokens for display (chips render in the Citations footer); a
  // streaming half-token (a trailing "[[" mid-stream) is hidden so it never flashes raw.
  const display = useMemo(() => stripCitationTokens(content), [content]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm leading-relaxed text-foreground/90 [&_a]:text-primary [&_code]:font-mono [&_code]:text-[0.85em] [&_p]:my-1.5 [&_h1]:text-base [&_h2]:text-sm [&_h2]:font-semibold [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
        <Streamdown>{display}</Streamdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-primary align-middle" />
        )}
      </div>
      {citations.length > 0 && (
        <CitationFooter
          citations={citations}
          interviewTitle={interviewTitle}
          onOpen={onOpenCitation}
        />
      )}
    </div>
  );
}

function CitationFooter({
  citations,
  interviewTitle,
  onOpen,
}: {
  citations: ChatCitation[];
  interviewTitle: (id: string) => string;
  onOpen: (c: ChatCitation) => void;
}) {
  // De-dupe identical citations.
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return (
    <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
      {unique.map((c, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onOpen(c)}
          className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 font-numeric text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          {chipLabel(c, interviewTitle)}
        </button>
      ))}
    </div>
  );
}

function chipLabel(c: ChatCitation, interviewTitle: (id: string) => string): string {
  if (c.kind === "finding") return c.finding_id;
  if (c.kind === "interview") return interviewTitle(c.interview_id);
  return `${interviewTitle(c.interview_id)} · seg ${c.segment_id + 1}`;
}

// Hide [[…]] tokens (and a dangling half-token mid-stream) from the rendered markdown.
function stripCitationTokens(s: string): string {
  return s
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[[^\]]*$/g, "") // dangling open token while streaming
    .replace(/[ \t]+\./g, ".") // tidy the space a removed token leaves before a period
    .replace(/[ \t]{2,}/g, " ");
}

// --- composer -----------------------------------------------------------------

function Composer({
  isRunning,
  onSend,
  onStop,
}: {
  isRunning: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    if (!text.trim() || isRunning) return;
    onSend(text);
    setText("");
  }

  return (
    <div className="shrink-0 border-t border-border p-2.5">
      <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-2.5 py-2 focus-within:border-border-strong">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask about this cycle…  (Enter to send, Shift+Enter for a newline)"
          className="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        />
        {isRunning ? (
          <Button
            size="icon"
            variant="secondary"
            className="size-7 shrink-0"
            onClick={onStop}
            aria-label="Stop"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-7 shrink-0"
            onClick={submit}
            disabled={!text.trim()}
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
