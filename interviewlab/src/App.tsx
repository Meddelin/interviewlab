import { useEffect } from "react";
import { Search, Sparkles } from "lucide-react";
import { NavLink, Outlet, useMatch } from "react-router-dom";
import { BackendStatus } from "@/components/backend-status";
import { CommandPalette } from "@/components/command-palette";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { ThemeToggle } from "@/components/theme-toggle";
import { CycleChatPanel } from "@/components/cycle-chat-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useUiStore } from "@/lib/ui-store";
import { useLiveAsr } from "@/lib/use-live-asr";
import { mod } from "@/lib/platform";
import { cn } from "@/lib/utils";

// React Router shell (M2): App is the layout; nested routes render in <Outlet />.
// ponytail: Cycles / Guides / Settings are too few items to justify a left sidebar,
// so the shell is a compact TOP HEADER nav and the work area gets the full width.
const NAV: { to: string; label: string }[] = [
  { to: "/cycles", label: "Cycles" },
  { to: "/guides", label: "Guides" },
  { to: "/products", label: "Products" },
  { to: "/settings", label: "Settings" },
];

// The current cycle id, if the route is within a cycle (detail OR transcript editor).
// The chat is cycle-scoped, so both screens ground on the same cycle. Returns null on
// the cycles list / guides / settings, where the Ask AI CTA + panel are hidden.
function useCurrentCycleId(): string | null {
  const detail = useMatch("/cycles/:id");
  const editor = useMatch("/cycles/:cycleId/interviews/:interviewId");
  return (
    editor?.params.cycleId ?? detail?.params.id ?? null
  );
}

// Accent-tinted "Ask AI" CTA, lifted from the cycle tab bar to the global header so it's
// reachable on EVERY cycle screen (incl. the transcript editor). Pressed = panel open.
// Still one of three triggers (this CTA + Cmd+K "Chat about this cycle" + ⌘J).
function AskAiButton({ cycleId }: { cycleId: string }) {
  const chatOpen = useUiStore((s) => s.chatOpenByCycle[cycleId] ?? false);
  const toggleChat = useUiStore((s) => s.toggleChat);

  return (
    <button
      type="button"
      aria-pressed={chatOpen}
      onClick={() => toggleChat(cycleId)}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        chatOpen
          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/15",
      )}
    >
      <Sparkles className="size-3.5" />
      Ask AI
      <kbd
        className={cn(
          "font-numeric text-[10px]",
          chatOpen ? "text-primary-foreground/70" : "text-primary/60",
        )}
      >
        {mod("J")}
      </kbd>
    </button>
  );
}

// Compact top header: workspace mark + title, quiet nav links (accent active state),
// the cycle-scoped Ask AI CTA (cycle routes only), the Search ⌘K affordance, the
// backend-status dot, and the theme toggle.
function Header({ cycleId }: { cycleId: string | null }) {
  const setCommandOpen = useUiStore((s) => s.setCommandOpen);

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border px-4">
      {/* Workspace mark — a quiet accent square, not a logo splash. */}
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
          IL
        </span>
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">
          InterviewLab
        </span>
      </div>

      {/* Quiet header links — active item marked with the accent, not a heavy pill. */}
      <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            // NavLink sets aria-current="page" on the active link automatically; the
            // explicit prop documents that wayfinding contract (default is "page").
            aria-current="page"
            className={({ isActive }) =>
              cn(
                "rounded-md px-2.5 py-1 transition-colors",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <span className="relative">
                {item.label}
                {isActive && (
                  <span className="absolute -bottom-[13px] left-0 h-0.5 w-full rounded-full bg-primary" />
                )}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* Ask AI — only within a cycle (detail or editor); hidden on list/guides/settings. */}
        {cycleId && <AskAiButton cycleId={cycleId} />}
        {/* Quiet palette affordance — the discoverable entry to Cmd+K. */}
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="hidden items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:flex"
          aria-label="Open command palette"
        >
          <Search className="size-3.5" />
          <span>Search</span>
          <kbd className="font-numeric text-[10px] tracking-wide text-muted-foreground/80">
            {mod("K")}
          </kbd>
        </button>
        <BackendStatus />
        <ThemeToggle />
      </div>
    </header>
  );
}

function App() {
  const cycleId = useCurrentCycleId();

  // Capture live transcription/diarization progress globally so opening an interview
  // mid-run shows it filling in (and the editor swaps to the stored transcript on finish).
  useLiveAsr();

  // Chat state lives at the shell now (lifted from cycle-detail) so the panel docks on
  // ANY cycle screen, incl. the transcript editor. Open/width persist per cycle.
  const chatOpen = useUiStore((s) =>
    cycleId ? (s.chatOpenByCycle[cycleId] ?? false) : false,
  );
  const chatWidthByCycle = useUiStore((s) => s.chatWidthByCycle);
  const setChatOpen = useUiStore((s) => s.setChatOpen);
  const toggleChat = useUiStore((s) => s.toggleChat);
  const setChatWidth = useUiStore((s) => s.setChatWidth);
  const chatOpenRequest = useUiStore((s) => s.chatOpenRequest);

  // The command-palette action ("Chat about this cycle") bumps chatOpenRequest → open here.
  useEffect(() => {
    if (chatOpenRequest > 0 && cycleId) setChatOpen(cycleId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpenRequest]);

  // ⌘/Ctrl+J toggles the panel from anywhere in a cycle (detail OR editor).
  useEffect(() => {
    if (!cycleId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleChat(cycleId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleId, toggleChat]);

  const panelOpen = Boolean(cycleId) && chatOpen;
  const width = cycleId ? (chatWidthByCycle[cycleId] ?? 32) : 32;

  return (
    // Full-height shell: a compact header + a full-width work area below it.
    <div className="flex h-svh min-h-0 flex-col">
      {/* Skip-link: first focusable element, visually hidden until focused (keyboard
          users Tab to it, then jump straight past the header nav to the content). */}
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:border focus-visible:border-border focus-visible:bg-popover focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-sm focus-visible:text-foreground focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Перейти к содержимому
      </a>
      <Header cycleId={cycleId} />

      {/* The work area docks the chat panel against the WHOLE content (any cycle screen).
          ponytail: collapsed = the panel is fully unmounted (zero width, no handle), so
          the content stretches to fill the freed width — not a fixed rail. */}
      {panelOpen && cycleId ? (
        <ResizablePanelGroup
          direction="horizontal"
          className="min-h-0 min-w-0 flex-1"
          onLayout={(sizes) => {
            // Persist the panel width per cycle (second panel = the chat).
            if (sizes.length === 2) setChatWidth(cycleId, Math.round(sizes[1]));
          }}
        >
          <ResizablePanel
            defaultSize={100 - width}
            minSize={40}
            className="min-w-0"
          >
            <div className="h-full overflow-auto">
              <WorkArea />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            defaultSize={width}
            minSize={22}
            maxSize={55}
            className="overflow-hidden border-l border-border"
          >
            <CycleChatPanel cycleId={cycleId} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <WorkArea />
        </div>
      )}

      <CommandPalette />
      {/* First-run guided setup — mounted once at the shell; self-gates on a localStorage
          flag, so it only surfaces until the user finishes or skips it. */}
      <OnboardingWizard />
    </div>
  );
}

// The routed content. The transcript editor is a dense, full-bleed screen (its own
// sub-toolbar + edge-to-edge two-pane body), so it opts out of the shell's side padding
// and fills the pane; the rest get sensible side padding. min-w-0 lets full-width tables
// shrink within flex instead of forcing the intrinsic width.
function WorkArea() {
  const isEditor = useMatch("/cycles/:cycleId/interviews/:interviewId");
  // <main> is the skip-link target. Only one WorkArea mounts at a time (the panel-open /
  // panel-closed branches are mutually exclusive), so the id stays unique.
  return (
    <main
      id="main"
      className={cn(
        "h-full w-full",
        // Center content in a capped column so it isn't pinned to the left with dead
        // space on wide/ultrawide screens (Linear-style). Editor stays full-bleed.
        !isEditor && "mx-auto max-w-screen-xl px-6 py-6 lg:px-8",
      )}
    >
      <Outlet />
    </main>
  );
}

export default App;
