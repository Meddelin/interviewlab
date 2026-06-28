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
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    searchPlaceholder: "Поиск или переход…",
    noResults: "Ничего не найдено.",
    actions: "Действия",
    newCycle: "Новый цикл",
    chatAboutCycle: "Обсудить этот цикл",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",
    keyboardShortcuts: "Горячие клавиши",
    goTo: "Перейти к",
    cycles: "Циклы",
    guides: "Гайды",
    products: "Продукты",
    settings: "Настройки",
    jumpToCycle: "Перейти к циклу",
    jumpToGuide: "Перейти к гайду",
    jumpToProduct: "Перейти к продукту",
    shortcutsHintBefore: "У частых действий есть горячая клавиша. Нажмите ",
    shortcutsHintAfter: " для полной командной палитры.",
    scOpenPalette: "Открыть командную палитру",
    scToggleChat: "Открыть/закрыть чат цикла (внутри цикла)",
    scShowShortcuts: "Показать этот список горячих клавиш",
  },
  en: {
    searchPlaceholder: "Search or jump to…",
    noResults: "No results.",
    actions: "Actions",
    newCycle: "New cycle",
    chatAboutCycle: "Chat about this cycle",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    keyboardShortcuts: "Keyboard shortcuts",
    goTo: "Go to",
    cycles: "Cycles",
    guides: "Guides",
    products: "Products",
    settings: "Settings",
    jumpToCycle: "Jump to cycle",
    jumpToGuide: "Jump to guide",
    jumpToProduct: "Jump to product",
    shortcutsHintBefore: "Common actions have a shortcut. Press ",
    shortcutsHintAfter: " for the full command palette.",
    scOpenPalette: "Open command palette",
    scToggleChat: "Toggle the cycle chat (within a cycle)",
    scShowShortcuts: "Show this keyboard shortcuts list",
  },
};

// Local registry of the app's keyboard shortcuts — the single source for both the
// cheatsheet (opened with "?") and the hints shown next to palette items. Kept in this
// file deliberately: the set is tiny and there's no second consumer yet, so a shared
// module would be premature (// ponytail: a const beats a new module for ~4 keys).
const SHORTCUTS: { keys: string; labelKey: "scOpenPalette" | "scToggleChat" | "scShowShortcuts" }[] = [
  { keys: mod("K"), labelKey: "scOpenPalette" },
  { keys: mod("J"), labelKey: "scToggleChat" },
  { keys: "?", labelKey: "scShowShortcuts" },
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
  const t = useT(STR);

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
        <CommandInput placeholder={t.searchPlaceholder} />
        <CommandList>
          <CommandEmpty>{t.noResults}</CommandEmpty>

          <CommandGroup heading={t.actions}>
            <CommandItem
              onSelect={() => run(() => requestNewCycle())}
              keywords={["create", "add", "wave"]}
            >
              <Plus />
              <span>{t.newCycle}</span>
            </CommandItem>
            {inCycle && (
              <CommandItem
                onSelect={() => run(() => requestChatOpen())}
                keywords={["chat", "ask", "assistant", "question"]}
              >
                <MessageSquare />
                <span>{t.chatAboutCycle}</span>
                <CommandShortcut>{mod("J")}</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem
              onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
              keywords={["dark", "light", "appearance"]}
            >
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? t.switchToLight : t.switchToDark}</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => setShortcutsOpen(true))}
              keywords={["help", "keys", "hotkeys", "cheatsheet"]}
            >
              <Keyboard />
              <span>{t.keyboardShortcuts}</span>
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading={t.goTo}>
            <CommandItem
              onSelect={() => run(() => navigate("/cycles"))}
              keywords={["waves", "research"]}
            >
              <FolderKanban />
              <span>{t.cycles}</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/guides"))}
              keywords={["interview", "script", "questions"]}
            >
              <BookText />
              <span>{t.guides}</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/products"))}
              keywords={["library", "context"]}
            >
              <Package />
              <span>{t.products}</span>
            </CommandItem>
            <CommandItem
              onSelect={() => run(() => navigate("/settings"))}
              keywords={["preferences", "config", "models", "cli"]}
            >
              <SettingsIcon />
              <span>{t.settings}</span>
            </CommandItem>
          </CommandGroup>

          {cycles && cycles.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t.jumpToCycle}>
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
              <CommandGroup heading={t.jumpToGuide}>
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
              <CommandGroup heading={t.jumpToProduct}>
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
            <DialogTitle>{t.keyboardShortcuts}</DialogTitle>
            <DialogDescription>
              {t.shortcutsHintBefore}
              <kbd className="font-numeric">{mod("K")}</kbd>
              {t.shortcutsHintAfter}
            </DialogDescription>
          </DialogHeader>
          <dl className="flex flex-col gap-2 text-sm">
            {SHORTCUTS.map((s) => (
              <div
                key={s.keys}
                className="flex items-center justify-between gap-4"
              >
                <dt className="text-muted-foreground">{t[s.labelKey]}</dt>
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
