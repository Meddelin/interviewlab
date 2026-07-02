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
// markdown renderer for the assistant turn).
//
// Phase B (v3 F3): assistant turns also render ACTION CHIPS — the whitelisted writes the
// agent performed (chat_tool_call rows / live `action` events), with per-chip Undo — plus
// a Retry affordance on failed turns.

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
  Book,
  Check,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Pencil,
  PenLine,
  PanelRightClose,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
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
  listChatToolCalls,
  onChatEvent,
  undoChatAction,
  type ChatCitation,
  type ChatMessage,
  type ChatToolCall,
} from "@/lib/tauri";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  chatKeys,
  useChatMessages,
  useChatThreads,
  useCreateChatThread,
  useDeleteChatThread,
  useRenameChatThread,
} from "@/lib/chat-queries";
import { useInterviews } from "@/lib/interview-queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUiStore } from "@/lib/ui-store";
import { mod } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useT, tr } from "@/lib/i18n";

const STR = {
  ru: {
    // Suggested starter questions for the empty state (mirrors the synthesis-tab empty state).
    starters: [
      "Сформулируй главные возражения в этом цикле",
      "Что дизайнеры говорили про онбординг?",
      "Что изменилось по сравнению с предыдущей волной?",
      "В каких интервью упоминается цена?",
    ],
    closeChat: "Закрыть панель чата",
    close: (key: string) => `Закрыть (${key})`,
    chatsInCycle: "Чаты в этом цикле",
    noChatsYet: "Чатов пока нет. Начните ниже.",
    newChat: "Новый чат",
    untitledChat: "Чат без названия",
    selectChat: "Выберите чат",
    chatAboutCycle: "Чат об этом цикле",
    switchChatThread: "Переключить тред чата",
    renameLabel: (title: string) => `Переименовать ${title || "чат"}`,
    deleteLabel: (title: string) => `Удалить ${title || "чат"}`,
    saveName: "Сохранить название",
    cancelRename: "Отменить переименование",
    chatName: "Название чата",
    deleteChatTitle: "Удалить чат?",
    deleteConfirm: (label: string) => `Удалить «${label}»? Это действие нельзя отменить.`,
    delete: "Удалить",
    thisChat: "этот чат",
    retry: "Повторить",
    retryAria: "Повторить ответ",
    undoAction: "Отменить",
    undoActionAria: (summary: string) => `Отменить действие: ${summary}`,
    actionUndone: "Действие отменено",
    undoFailed: (e: string) => `Не удалось отменить действие. ${e}`,
    actionStatusApplied: "Применено",
    actionStatusRejected: "Отклонено",
    actionStatusFailed: "Ошибка",
    actionStatusUndone: "Отменено",
    emptyHint:
      "Спросите что угодно об этом цикле — ответы опираются на синтез цикла, краткие итоги интервью и diff, со ссылками на источник.",
    interview: "Интервью",
    composerPlaceholder: "Спросите об этом цикле…  (Enter — отправить, Shift+Enter — новая строка)",
    stop: "Остановить",
    send: "Отправить",
    seg: (n: number) => `сегм. ${n}`,
  },
  en: {
    starters: [
      "Summarize the top objections in this cycle",
      "What did designers say about onboarding?",
      "What changed vs the previous wave?",
      "Which interviews mention pricing?",
    ],
    closeChat: "Close chat panel",
    close: (key: string) => `Close (${key})`,
    chatsInCycle: "Chats in this cycle",
    noChatsYet: "No chats yet. Start one below.",
    newChat: "New chat",
    untitledChat: "Untitled chat",
    selectChat: "Select a chat",
    chatAboutCycle: "Chat about this cycle",
    switchChatThread: "Switch chat thread",
    renameLabel: (title: string) => `Rename ${title || "chat"}`,
    deleteLabel: (title: string) => `Delete ${title || "chat"}`,
    saveName: "Save name",
    cancelRename: "Cancel rename",
    chatName: "Chat name",
    deleteChatTitle: "Delete chat?",
    deleteConfirm: (label: string) => `Delete "${label}"? This can't be undone.`,
    delete: "Delete",
    thisChat: "this chat",
    retry: "Retry",
    retryAria: "Retry the answer",
    undoAction: "Undo",
    undoActionAria: (summary: string) => `Undo action: ${summary}`,
    actionUndone: "Action undone",
    undoFailed: (e: string) => `Couldn't undo the action. ${e}`,
    actionStatusApplied: "Applied",
    actionStatusRejected: "Rejected",
    actionStatusFailed: "Failed",
    actionStatusUndone: "Undone",
    emptyHint:
      "Ask anything about this cycle — answers are grounded in its synthesis, per-interview summaries, and diff, with citations back to the source.",
    interview: "Interview",
    composerPlaceholder: "Ask about this cycle…  (Enter to send, Shift+Enter for a newline)",
    stop: "Stop",
    send: "Send",
    seg: (n: number) => `seg ${n}`,
  },
} as const;

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

// --- chat actions (M11 Phase B tool-use chips) ----------------------------------
// What an action chip renders — a normalized slice of a chat_tool_call row, or of a live
// `action` stream event (whose row isn't in the query cache yet).
type ChipAction = {
  id: string;
  tool: string;
  status: ChatToolCall["status"];
  summary: string;
  error: string | null;
  /** Only persisted APPLIED rows are undoable (the live chip flips at `done`). */
  undoable: boolean;
};

const toolCallsKey = (threadId: string) => ["chat-tool-calls", threadId] as const;

// result_json always carries { summary } per the contract; fall back to the raw tool id
// for failed/rejected rows whose result never materialized.
function actionSummary(c: ChatToolCall): string {
  if (c.result_json) {
    try {
      const v = JSON.parse(c.result_json) as { summary?: unknown };
      if (typeof v.summary === "string" && v.summary) return v.summary;
    } catch {
      // fall through to the tool id
    }
  }
  return c.tool;
}

function toChip(c: ChatToolCall): ChipAction {
  return {
    id: c.id,
    tool: c.tool,
    status: c.status,
    summary: actionSummary(c),
    error: c.error,
    undoable: c.status === "applied" && c.undo_token != null,
  };
}

// Hide the raw ```invlab-action {json}``` fenced block from the STREAMED text (the
// persisted message is already stripped server-side; on `done` the refetch swaps it in).
// Also hides a dangling, still-open fence mid-stream so it never flashes raw JSON.
function stripActionBlocks(s: string): string {
  return s
    .replace(/```invlab-action[\s\S]*?```/g, "")
    .replace(/```invlab-action[\s\S]*$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function CycleChatPanel({ cycleId }: { cycleId: string }) {
  const t = useT(STR);
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

  // Persisted tool-call rows for this thread → action chips under their assistant turns.
  // Live `action` stream events append to liveActions mid-turn; `done` invalidates this
  // query (the rows are persisted by then) and clears the live buffer.
  const { data: toolCalls } = useQuery({
    queryKey: toolCallsKey(threadId ?? ""),
    queryFn: () => listChatToolCalls(threadId as string),
    enabled: !!threadId,
  });
  const actionsByMessage = useMemo(() => {
    const map = new Map<string, ChipAction[]>();
    for (const c of toolCalls ?? []) {
      const chip = toChip(c);
      const arr = map.get(c.message_id);
      if (arr) arr.push(chip);
      else map.set(c.message_id, [chip]);
    }
    return map;
  }, [toolCalls]);

  // Undo one applied action: consumes the row's undo_token, flips the chip to `undone`.
  const undoAction = useMutation({
    mutationFn: (toolCallId: string) => undoChatAction(toolCallId),
    onSuccess: (updated) => {
      qc.setQueryData<ChatToolCall[]>(toolCallsKey(updated.thread_id), (prev) =>
        prev?.map((c) => (c.id === updated.id ? updated : c)),
      );
      toast.success(tr(STR).actionUndone);
    },
    onError: (e) => toast.error(tr(STR).undoFailed(String(e))),
  });

  // The live message list = persisted history + an in-flight streaming buffer.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamBuf, setStreamBuf] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Actions streamed for the CURRENT turn (chips on the draft bubble, pre-persistence).
  const [liveActions, setLiveActions] = useState<ChipAction[]>([]);
  // The thread pending delete confirmation (ConfirmDialog replaced the native confirm).
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);
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
    setLiveActions([]);
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

  // Run ONE assistant turn on a thread: subscribe to the stream, then invoke
  // cycle_chat_send. The user message must already be persisted — retry() reuses this to
  // re-run a failed turn WITHOUT appending a duplicate user message. Tokens append to
  // streamBuf; `action` events chip onto the draft bubble; `done` refreshes the history
  // (the persisted assistant message is stored stripped of the raw action block, so the
  // refetch REPLACES the raw streamed draft).
  async function runTurn(tid: string, text: string) {
    runningThreadRef.current = tid;

    // Set up the in-flight assistant buffer + subscribe BEFORE sending so no token is lost.
    const localStreamId = "streaming-" + Date.now();
    setStreamingId(localStreamId);
    setStreamBuf("");
    setLiveActions([]);
    setIsRunning(true);

    const threadForEvents = tid;
    unlistenRef.current?.();
    unlistenRef.current = onChatEvent(threadForEvents, (e) => {
      if (e.kind === "token") {
        setStreamBuf((b) => b + e.text);
      } else if (e.kind === "action") {
        // One processed whitelisted action — chip it onto the streaming bubble right
        // away; the persisted row (with undo_token) lands with `done` below.
        setLiveActions((prev) => [
          ...prev,
          {
            id: e.tool_call_id,
            tool: e.tool,
            status: e.status,
            summary: e.summary,
            error: null,
            undoable: false,
          },
        ]);
      } else if (e.kind === "done") {
        setIsRunning(false);
        setStreamingId(null);
        setStreamBuf("");
        setLiveActions([]);
        runningThreadRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
        qc.invalidateQueries({ queryKey: chatKeys.messages(threadForEvents) });
        qc.invalidateQueries({ queryKey: toolCallsKey(threadForEvents) });
        qc.invalidateQueries({ queryKey: chatKeys.threads(cycleId) });
      } else if (e.kind === "error") {
        setIsRunning(false);
        setStreamingId(null);
        setStreamBuf("");
        setLiveActions([]);
        runningThreadRef.current = null;
        unlistenRef.current?.();
        unlistenRef.current = null;
        if (e.message !== "cancelled") setError(e.message);
        qc.invalidateQueries({ queryKey: chatKeys.messages(threadForEvents) });
        qc.invalidateQueries({ queryKey: toolCallsKey(threadForEvents) });
      }
    });

    try {
      await cycleChatSend(threadForEvents, cycleId, text);
    } catch (err) {
      setIsRunning(false);
      setStreamingId(null);
      setLiveActions([]);
      runningThreadRef.current = null;
      setError(String(err));
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  // Send a turn: ensure a thread, persist the user message, then run the turn.
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

    await runTurn(tid, clean);
  }

  // Retry a FAILED assistant turn: re-run send for the user message that produced it,
  // WITHOUT re-appending that user message (no duplicate). The fresh answer lands as a
  // new assistant message on the same thread.
  async function retry(failedMessageId: string) {
    if (!threadId || isRunning) return;
    setError(null);
    const list = persisted ?? [];
    const at = list.findIndex((m) => m.id === failedMessageId);
    const scope = at === -1 ? list : list.slice(0, at);
    const lastUser = [...scope].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    await runTurn(threadId, lastUser.content);
  }

  async function stop() {
    if (threadId) await cycleChatCancel(threadId);
    setIsRunning(false);
    setStreamingId(null);
    setStreamBuf("");
    setLiveActions([]);
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
    interviews?.find((i) => i.id === id)?.title ?? t.interview;

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
              // Destructive → the shared ConfirmDialog (v3 F3), not a native confirm.
              const thread = threads?.find((x) => x.id === id);
              setDeleteTarget({
                id,
                label: thread?.title?.trim() || t.thisChat,
              });
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => setChatOpen(cycleId, false)}
                aria-label={t.closeChat}
              >
                <PanelRightClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t.close(mod("J"))}</TooltipContent>
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
                      actions={
                        m.streaming
                          ? liveActions
                          : (actionsByMessage.get(m.id) ?? [])
                      }
                      error={m.error ?? null}
                      canRetry={!isRunning}
                      onRetry={() => retry(m.id)}
                      onUndoAction={(id) => undoAction.mutate(id)}
                      undoingId={
                        undoAction.isPending
                          ? (undoAction.variables ?? null)
                          : null
                      }
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

        {/* Thread-delete confirm (destructive; replaces the old native confirm). */}
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(o) => {
            if (!o) setDeleteTarget(null);
          }}
          title={t.deleteChatTitle}
          body={t.deleteConfirm(deleteTarget?.label ?? "")}
          confirmLabel={t.delete}
          destructive
          onConfirm={() => {
            if (!deleteTarget) return;
            const { id } = deleteTarget;
            deleteThread.mutate(id);
            // Switch to the next remaining thread (newest), else empty state.
            if (id === threadId) {
              const next = threads?.find((x) => x.id !== id);
              setThreadId(next ? next.id : null);
            }
            setDeleteTarget(null);
          }}
        />
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
  const t = useT(STR);
  const [open, setOpen] = useState(false);
  // The thread row currently being renamed inline (id), if any.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  if (pending) {
    return <Skeleton className="h-7 flex-1" />;
  }

  const hasThreads = !!threads && threads.length > 0;
  const triggerLabel = threadId
    ? activeTitle.trim() || t.untitledChat
    : hasThreads
      ? t.selectChat
      : t.chatAboutCycle;

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
          aria-label={t.switchChatThread}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <div className="mb-1 px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t.chatsInCycle}
        </div>
        {hasThreads ? (
          <ul className="max-h-72 overflow-y-auto">
            {threads!.map((thread) =>
              renamingId === thread.id ? (
                <li key={thread.id} className="px-0.5 py-0.5">
                  <RenameRow
                    initial={thread.title}
                    onCancel={() => setRenamingId(null)}
                    onSave={(title) => {
                      onRename(thread.id, title);
                      setRenamingId(null);
                    }}
                  />
                </li>
              ) : (
                <li key={thread.id} className="group/row flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(thread.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-secondary/70 aria-[current=true]:bg-secondary/50"
                    aria-current={thread.id === threadId}
                  >
                    <Check
                      className={`size-3.5 shrink-0 ${
                        thread.id === threadId
                          ? "text-primary"
                          : "text-transparent"
                      }`}
                    />
                    <span className="truncate">
                      {thread.title.trim() || t.untitledChat}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => setRenamingId(thread.id)}
                      aria-label={t.renameLabel(thread.title)}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-status-error"
                      onClick={() => onDelete(thread.id)}
                      aria-label={t.deleteLabel(thread.title)}
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
            {t.noChatsYet}
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
            {t.newChat}
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
  const t = useT(STR);
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
        placeholder={t.chatName}
      />
      <Button type="submit" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t.saveName}>
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onCancel}
        aria-label={t.cancelRename}
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}

// --- empty state --------------------------------------------------------------

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const t = useT(STR);
  return (
    <div className="flex flex-col gap-4 pt-6">
      <p className="text-sm text-muted-foreground">
        {t.emptyHint}
      </p>
      <div className="flex flex-col gap-2">
        {t.starters.map((q) => (
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
  actions,
  error,
  canRetry,
  onRetry,
  onUndoAction,
  undoingId,
  interviewTitle,
  onOpenCitation,
}: {
  content: string;
  citations: ChatCitation[];
  streaming?: boolean;
  // Processed agent actions for THIS turn (persisted rows, or live events while streaming).
  actions: ChipAction[];
  // The persisted turn's error (status=error) — shown with a Retry affordance.
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
  onUndoAction: (toolCallId: string) => void;
  // The tool-call id whose undo is in flight (spinner on that chip), if any.
  undoingId: string | null;
  interviewTitle: (id: string) => string;
  onOpenCitation: (c: ChatCitation) => void;
}) {
  const t = useT(STR);
  // Strip the inline [[…]] tokens for display (chips render in the Citations footer) and
  // the raw ```invlab-action``` fenced block (streamed text still carries it; the stored
  // message is stripped server-side). A dangling half-token mid-stream never flashes raw.
  const display = useMemo(
    () => stripCitationTokens(stripActionBlocks(content)),
    [content],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm leading-relaxed text-foreground/90 [&_a]:text-primary [&_code]:font-mono [&_code]:text-[0.85em] [&_p]:my-1.5 [&_h1]:text-base [&_h2]:text-sm [&_h2]:font-semibold [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
        <Streamdown>{display}</Streamdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-full bg-primary align-middle" />
        )}
      </div>

      {/* Agent action chips: what this turn actually DID (glossary/synthesis writes). */}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {actions.map((a) => (
            <ActionChip
              key={a.id}
              action={a}
              undoing={undoingId === a.id}
              onUndo={a.undoable ? () => onUndoAction(a.id) : undefined}
            />
          ))}
        </div>
      )}

      {/* Failed turn → the stored error + a Retry that re-runs the send (no duplicate
          user message; see retry()). */}
      {error && !streaming && (
        <div className="flex items-center gap-2 rounded-md border border-status-error/40 bg-status-error/5 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-xs break-words text-status-error">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry}
            aria-label={t.retryAria}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-secondary/40 px-1.5 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          >
            <RotateCcw className="size-3" />
            {t.retry}
          </button>
        </div>
      )}

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

// --- action chips (M11 Phase B tool-use) ----------------------------------------
// One flat chip per processed agent action, attached under its assistant turn. Status is
// a quiet tint, not a loud badge: applied = ready-green with an inline Undo; rejected /
// failed = muted error with the reason in a tooltip; undone = struck & dimmed.

const TOOL_ICONS: Record<string, typeof Book> = {
  "glossary.add_terms": Book,
  "synthesis.update_finding": PenLine,
};

function ActionChip({
  action,
  undoing,
  onUndo,
}: {
  action: ChipAction;
  undoing: boolean;
  onUndo?: () => void;
}) {
  const t = useT(STR);
  const Icon = TOOL_ICONS[action.tool] ?? Wrench;
  const failed = action.status === "rejected" || action.status === "failed";
  const undone = action.status === "undone";
  const statusLabel =
    action.status === "applied"
      ? t.actionStatusApplied
      : action.status === "rejected"
        ? t.actionStatusRejected
        : action.status === "failed"
          ? t.actionStatusFailed
          : t.actionStatusUndone;

  const chip = (
    <span
      title={failed ? undefined : statusLabel}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
        action.status === "applied" &&
          "border-status-ready/30 bg-status-ready/10 text-status-ready",
        failed && "border-status-error/25 bg-status-error/5 text-status-error/80",
        undone && "border-border bg-secondary/30 text-muted-foreground",
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className={cn("min-w-0 truncate", undone && "line-through opacity-70")}>
        {action.summary}
      </span>
      {onUndo && !undone && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          aria-label={t.undoActionAria(action.summary)}
          className="ml-0.5 flex shrink-0 items-center gap-1 rounded border border-transparent px-1 py-0.5 font-medium transition-colors hover:border-status-ready/40 hover:bg-status-ready/10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
        >
          {undoing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Undo2 className="size-3" />
          )}
          {t.undoAction}
        </button>
      )}
    </span>
  );

  // Rejected/failed chips carry the reason in a tooltip (the chip stays quiet).
  if (failed && action.error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 break-words">
          {action.error}
        </TooltipContent>
      </Tooltip>
    );
  }
  return chip;
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
  return `${interviewTitle(c.interview_id)} · ${tr(STR).seg(c.segment_id + 1)}`;
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
  const t = useT(STR);
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
          placeholder={t.composerPlaceholder}
          className="max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        />
        {isRunning ? (
          <Button
            size="icon"
            variant="secondary"
            className="size-7 shrink-0"
            onClick={onStop}
            aria-label={t.stop}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-7 shrink-0"
            onClick={submit}
            disabled={!text.trim()}
            aria-label={t.send}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
