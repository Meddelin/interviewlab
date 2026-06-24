import { useEffect } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  FolderKanban,
  MessageSquare,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useCycles } from "@/lib/cycle-queries";
import { useUiStore } from "@/lib/ui-store";

// The signature interaction: Cmd/Ctrl+K opens a fuzzy palette for fast navigation
// and the common actions (new cycle, jump to a cycle, settings, toggle theme).
export function CommandPalette() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const open = useUiStore((s) => s.commandOpen);
  const setOpen = useUiStore((s) => s.setCommandOpen);
  const requestNewCycle = useUiStore((s) => s.requestNewCycle);
  const requestChatOpen = useUiStore((s) => s.requestChatOpen);
  const { data: cycles } = useCycles();
  // "Chat about this cycle" is meaningful on any cycle screen — the detail page OR the
  // transcript editor (both ground the chat on the same cycle; the panel lives in the shell).
  const onCycleDetail = useMatch("/cycles/:id");
  const onTranscriptEditor = useMatch("/cycles/:cycleId/interviews/:interviewId");
  const inCycle = Boolean(onCycleDetail || onTranscriptEditor);

  // Global Cmd/Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().commandOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // Run an action, then close the palette.
  function run(action: () => void) {
    setOpen(false);
    action();
  }

  const isDark = theme !== "light";

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search cycles or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => run(() => requestNewCycle())}
            keywords={["create", "add", "wave"]}
          >
            <Plus />
            <span>New cycle</span>
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
          {inCycle && (
            <CommandItem
              onSelect={() => run(() => requestChatOpen())}
              keywords={["chat", "ask", "assistant", "question"]}
            >
              <MessageSquare />
              <span>Chat about this cycle</span>
              <CommandShortcut>⌘J</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem
            onSelect={() => run(() => navigate("/settings"))}
            keywords={["preferences", "config"]}
          >
            <SettingsIcon />
            <span>Go to settings</span>
          </CommandItem>
          <CommandItem
            onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
            keywords={["dark", "light", "appearance"]}
          >
            {isDark ? <Sun /> : <Moon />}
            <span>{isDark ? "Switch to light theme" : "Switch to dark theme"}</span>
          </CommandItem>
        </CommandGroup>

        {cycles && cycles.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Jump to cycle">
              {cycles.map((cycle) => (
                <CommandItem
                  key={cycle.id}
                  value={`cycle ${cycle.name}`}
                  onSelect={() => run(() => navigate(`/cycles/${cycle.id}`))}
                >
                  <FolderKanban />
                  <span className="truncate">{cycle.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
