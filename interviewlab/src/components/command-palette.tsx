import { useEffect, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  BookText,
  FileAudio,
  FolderKanban,
  GitCompare,
  Keyboard,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
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
import { modShift } from "@/components/task-center";
import { useCycles } from "@/lib/cycle-queries";
import { useGuides } from "@/lib/guide-queries";
import { useInterviews } from "@/lib/interview-queries";
import { useProducts } from "@/lib/product-queries";
import { mod } from "@/lib/platform";
import { useTaskStore } from "@/lib/task-store";
import { useUiStore } from "@/lib/ui-store";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    searchPlaceholder: "Поиск или переход…",
    noResults: "Ничего не найдено.",
    actions: "Действия",
    newCycle: "Новый цикл",
    chatAboutCycle: "Обсудить этот цикл",
    backgroundTasks: "Фоновые задачи",
    switchToLight: "Переключить на светлую тему",
    switchToDark: "Переключить на тёмную тему",
    keyboardShortcuts: "Горячие клавиши",
    goTo: "Перейти к",
    cycles: "Циклы",
    guides: "Гайды",
    products: "Продукты",
    settings: "Настройки",
    settingsAiCli: "Настройки · AI CLI",
    settingsTranscription: "Настройки · Транскрипция",
    settingsRoles: "Настройки · Роли",
    settingsAbout: "Настройки · О приложении",
    cycleTabs: "Разделы цикла",
    tabOverview: "Обзор",
    tabInterviews: "Интервью",
    tabSynthesis: "Синтез",
    tabDiff: "Сравнение",
    cycleInterviews: "Интервью этого цикла",
    jumpToCycle: "Перейти к циклу",
    jumpToGuide: "Перейти к гайду",
    jumpToProduct: "Перейти к продукту",
    shortcutsHintBefore: "У частых действий есть горячая клавиша. Нажмите ",
    shortcutsHintAfter: " для полной командной палитры.",
    scOpenPalette: "Открыть командную палитру",
    scToggleChat: "Открыть/закрыть чат цикла (внутри цикла)",
    scToggleTasks: "Открыть/закрыть фоновые задачи",
    scShowShortcuts: "Показать этот список горячих клавиш",
  },
  en: {
    searchPlaceholder: "Search or jump to…",
    noResults: "No results.",
    actions: "Actions",
    newCycle: "New cycle",
    chatAboutCycle: "Chat about this cycle",
    backgroundTasks: "Background tasks",
    switchToLight: "Switch to light theme",
    switchToDark: "Switch to dark theme",
    keyboardShortcuts: "Keyboard shortcuts",
    goTo: "Go to",
    cycles: "Cycles",
    guides: "Guides",
    products: "Products",
    settings: "Settings",
    settingsAiCli: "Settings · AI CLI",
    settingsTranscription: "Settings · Transcription",
    settingsRoles: "Settings · Roles",
    settingsAbout: "Settings · About",
    cycleTabs: "Cycle sections",
    tabOverview: "Overview",
    tabInterviews: "Interviews",
    tabSynthesis: "Synthesis",
    tabDiff: "Diff",
    cycleInterviews: "Interviews in this cycle",
    jumpToCycle: "Jump to cycle",
    jumpToGuide: "Jump to guide",
    jumpToProduct: "Jump to product",
    shortcutsHintBefore: "Common actions have a shortcut. Press ",
    shortcutsHintAfter: " for the full command palette.",
    scOpenPalette: "Open command palette",
    scToggleChat: "Toggle the cycle chat (within a cycle)",
    scToggleTasks: "Toggle the background-tasks panel",
    scShowShortcuts: "Show this keyboard shortcuts list",
  },
};

// Local registry of the app's keyboard shortcuts — the single source for both the
// cheatsheet (opened with "?") and the hints shown next to palette items. Kept in this
// file deliberately: the set is tiny and there's no second consumer yet, so a shared
// module would be premature (// ponytail: a const beats a new module for ~4 keys).
const SHORTCUTS: {
  keys: string;
  labelKey: "scOpenPalette" | "scToggleChat" | "scToggleTasks" | "scShowShortcuts";
}[] = [
  { keys: mod("K"), labelKey: "scOpenPalette" },
  { keys: mod("J"), labelKey: "scToggleChat" },
  { keys: modShift("B"), labelKey: "scToggleTasks" },
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
  const toggleTasks = useTaskStore((s) => s.toggleOpen);
  const { data: cycles } = useCycles();
  const { data: guides } = useGuides();
  const { data: products } = useProducts();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // "Chat about this cycle" is meaningful on any cycle screen — the detail page OR the
  // transcript editor (both ground the chat on the same cycle; the panel lives in the shell).
  const onCycleDetail = useMatch("/cycles/:id");
  const onTranscriptEditor = useMatch("/cycles/:cycleId/interviews/:interviewId");
  const inCycle = Boolean(onCycleDetail || onTranscriptEditor);
  // The cycle the route is grounded on — drives the tab-switch + interview-jump groups.
  const cycleId =
    onTranscriptEditor?.params.cycleId ?? onCycleDetail?.params.id;
  // Fetch the current cycle's interviews only while the palette is open (usually a
  // cache hit — the Interviews tab shares the query key).
  const { data: cycleInterviews } = useInterviews(
    open ? cycleId : undefined,
  );
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
              onSelect={() => run(() => toggleTasks())}
              keywords={["tasks", "background", "progress", "задачи", "прогресс"]}
            >
              <ListChecks />
              <span>{t.backgroundTasks}</span>
              <CommandShortcut>{modShift("B")}</CommandShortcut>
            </CommandItem>
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

          {/* Inside a cycle: switch its tabs via the deep-linkable ?tab= param (the
              cycle-detail page reads it; overview is the canonical bare URL). */}
          {inCycle && cycleId && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t.cycleTabs}>
                <CommandItem
                  value="cycle tab overview"
                  onSelect={() => run(() => navigate(`/cycles/${cycleId}`))}
                  keywords={["overview", "обзор", "tab"]}
                >
                  <LayoutDashboard />
                  <span>{t.tabOverview}</span>
                </CommandItem>
                <CommandItem
                  value="cycle tab interviews"
                  onSelect={() =>
                    run(() => navigate(`/cycles/${cycleId}?tab=interviews`))
                  }
                  keywords={["interviews", "интервью", "tab"]}
                >
                  <FileAudio />
                  <span>{t.tabInterviews}</span>
                </CommandItem>
                <CommandItem
                  value="cycle tab synthesis"
                  onSelect={() =>
                    run(() => navigate(`/cycles/${cycleId}?tab=synthesis`))
                  }
                  keywords={["synthesis", "синтез", "findings", "tab"]}
                >
                  <Lightbulb />
                  <span>{t.tabSynthesis}</span>
                </CommandItem>
                <CommandItem
                  value="cycle tab diff"
                  onSelect={() =>
                    run(() => navigate(`/cycles/${cycleId}?tab=diff`))
                  }
                  keywords={["diff", "сравнение", "waves", "tab"]}
                >
                  <GitCompare />
                  <span>{t.tabDiff}</span>
                </CommandItem>
              </CommandGroup>
            </>
          )}

          {/* Inside a cycle: jump straight to any of its interviews (the editor). */}
          {inCycle &&
            cycleId &&
            cycleInterviews &&
            cycleInterviews.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={t.cycleInterviews}>
                  {cycleInterviews.map((interview) => (
                    <CommandItem
                      key={interview.id}
                      value={`interview ${interview.title}`}
                      onSelect={() =>
                        run(() =>
                          navigate(
                            `/cycles/${cycleId}/interviews/${interview.id}`,
                          ),
                        )
                      }
                    >
                      <FileAudio />
                      <span className="truncate">{interview.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

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
            {/* Settings sections — deep entries via ?tab= (harmless if the page
                ignores the param; it still lands on Settings). */}
            <CommandItem
              value="settings section ai cli"
              onSelect={() => run(() => navigate("/settings?tab=ai-cli"))}
              keywords={["adapter", "plugin", "claude", "cli"]}
            >
              <SettingsIcon />
              <span>{t.settingsAiCli}</span>
            </CommandItem>
            <CommandItem
              value="settings section transcription"
              onSelect={() =>
                run(() => navigate("/settings?tab=transcription"))
              }
              keywords={["whisper", "asr", "model", "транскрипция"]}
            >
              <SettingsIcon />
              <span>{t.settingsTranscription}</span>
            </CommandItem>
            <CommandItem
              value="settings section roles"
              onSelect={() => run(() => navigate("/settings?tab=roles"))}
              keywords={["speaker", "роли", "participants"]}
            >
              <SettingsIcon />
              <span>{t.settingsRoles}</span>
            </CommandItem>
            <CommandItem
              value="settings section about"
              onSelect={() => run(() => navigate("/settings?tab=about"))}
              keywords={["version", "о приложении"]}
            >
              <SettingsIcon />
              <span>{t.settingsAbout}</span>
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
