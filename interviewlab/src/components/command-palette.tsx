import { useEffect, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  BookText,
  FolderKanban,
  Keyboard,
  MessageSquare,
  Moon,
  Package,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCycles } from "@/lib/cycle-queries";
import { useGuides } from "@/lib/guide-queries";
import { useProducts } from "@/lib/product-queries";
import { mod } from "@/lib/platform";
import { useUiStore } from "@/lib/ui-store";

// Local registry of the app's keyboard shortcuts — the single source for both the
// cheatsheet (opened with "?") and the hints shown next to palette items. Kept in this
// file deliberately: the set is tiny and there's no second consumer yet, so a shared
// module would be premature (// ponytail: a const beats a new module for ~4 keys).
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: mod("K"), label: "Open command palette" },
  { keys: mod("J"), label: "Toggle the cycle chat (within a cycle)" },
  { keys: "?", label: "Show this keyboard shortcuts list" },
];

// The signature interaction: Cmd/Ctrl+K opens a fuzzy palette that is the app's
// navigation hub — jump to any cycle/guide/product screen, run the common actions
// (new cycle, chat, theme), and reach the shortcuts cheatsheet. "?" opens that
// cheatsheet directly from anywhere outside a text field.
export function CommandPalette() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const open = useUiStore((s) => s.commandOpen);
  const setOpen = useUiStore((s) => s.setCommandOpen);
  const requestNewCycle = useUiStore((s) => s.requestNewCycle);
  const requestChatOpen = useUiStore((s) => s.requestChatOpen);
  const { data: cycles } = useCycles();
  const { data: guides } = useGuides();
  const { data: products } = useProducts();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // "Chat about this cycle" is meaningful on any cycle screen — the detail page OR the
  // transcript editor (both ground the chat on the same cycle; the panel lives in the shell).
  const onCycleDetail = useMatch("/cycles/:id");
  const onTranscriptEditor = useMatch("/cycles/:cycleId/interviews/:interviewId");
  const inCycle = Boolean(onCycleDetail || onTranscriptEditor);

  // Global keys: Cmd/Ctrl+K toggles the palette; bare "?" opens the cheatsheet (but only
  // when the user isn't typing into a field, so it doesn't swallow real "?" input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!useUiStore.getState().commandOpen);
        return;
      }
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        const typing =
          el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.isContentEditable);
        if (typing) return;
        e.preventDefault();
        setShortcutsOpen(true);
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
    <>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search or jump to…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => run(() => requestNewCycle())}
              keywords={["create", "add", "wave"]}
            >
              <Plus />
              <span>New cycle</span>
            </CommandItem>
            {inCycle && (
              <CommandItem
                onSelect={() => run(() => requestChatOpen())}
                keywords={["chat", "ask", "assistant", "question"]}
              >
                <MessageSquare />
                <span>Chat about this cycle</span>
                <CommandShortcut>{mod("J")}</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem
              onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
              keywords={["dark", "light", "appearance"]}
            >
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? "Switch to light theme" : "Switch to dark theme"}</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => setShortcutsOpen(true))}
              keywords={["help", "keys", "hotkeys", "cheatsheet"]}
            >
              <Keyboard />
              <span>Keyboard shortcuts</span>
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Go to">
            <CommandItem
              onSelect={() => run(() => navigate("/cycles"))}
              keywords={["waves", "research"]}
            >
              <FolderKanban />
              <span>Cycles</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/guides"))}
              keywords={["interview", "script", "questions"]}
            >
              <BookText />
              <span>Guides</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/products"))}
              keywords={["library", "context"]}
            >
              <Package />
              <span>Products</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/settings"))}
              keywords={["preferences", "config", "models", "cli"]}
            >
              <SettingsIcon />
              <span>Settings</span>
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

          {guides && guides.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Jump to guide">
                {guides.map((guide) => (
                  <CommandItem
                    key={guide.id}
                    value={`guide ${guide.name}`}
                    // Guides have no deep-link route yet — land on the library, where the
                    // user picks the guide (selection is page-local, not in the URL).
                    onSelect={() => run(() => navigate("/guides"))}
                  >
                    <BookText />
                    <span className="truncate">{guide.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {products && products.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Jump to product">
                {products.map((product) => (
                  <CommandItem
                    key={product.id}
                    value={`product ${product.name}`}
                    onSelect={() => run(() => navigate("/products"))}
                  >
                    <Package />
                    <span className="truncate">{product.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>

      {/* Keyboard-shortcuts cheatsheet — opened from the palette or with "?". */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Common actions have a shortcut. Press{" "}
              <kbd className="font-numeric">{mod("K")}</kbd> for the full command palette.
            </DialogDescription>
          </DialogHeader>
          <dl className="flex flex-col gap-2 text-sm">
            {SHORTCUTS.map((s) => (
              <div
                key={s.keys}
                className="flex items-center justify-between gap-4"
              >
                <dt className="text-muted-foreground">{s.label}</dt>
                <dd>
                  <kbd className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 font-numeric text-xs text-foreground">
                    {s.keys}
                  </kbd>
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}
