import { create } from "zustand";

// Tiny UI coordination store: lets the command palette and the page share intent
// (e.g. "open the New cycle dialog") without prop-drilling. UI-only, no persistence.
type UiState = {
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;

  // Bumping this counter asks the cycles page to open its New cycle dialog.
  newCycleRequest: number;
  requestNewCycle: () => void;

  // ASR preferences (Milestone 4): the model + language the Interviews "Transcribe"
  // action uses. Chosen in Settings → Transcription; persisted to localStorage so the
  // choice survives reloads. ponytail: a tiny localStorage round-trip beats a whole
  // app_setting round-trip + query for two scalar prefs.
  asrModelId: string;
  asrLanguage: string;
  setAsrModelId: (id: string) => void;
  setAsrLanguage: (lang: string) => void;

  // Diarization preference: the expected speaker count the Transcribe / Re-diarize
  // actions force ("auto" = let diarization detect it, else "2" | "3" | "4"). Stored as a
  // string in localStorage (same rationale as the ASR prefs); callers map "auto"→null when
  // passing it to the backend's expectedSpeakers arg.
  asrExpectedSpeakers: string;
  setAsrExpectedSpeakers: (v: string) => void;

  // M11 chat: the cycle chat side panel. Open/width persist PER CYCLE (localStorage),
  // so reopening a cycle restores its panel state. A monotonically-bumped counter lets
  // Cmd+K / ⌘J request the panel open from anywhere without prop-drilling.
  chatOpenByCycle: Record<string, boolean>;
  chatWidthByCycle: Record<string, number>;
  chatOpenRequest: number; // bump → the open cycle detail opens its panel
  isChatOpen: (cycleId: string) => boolean;
  setChatOpen: (cycleId: string, open: boolean) => void;
  toggleChat: (cycleId: string) => void;
  requestChatOpen: () => void;
  chatWidth: (cycleId: string) => number;
  setChatWidth: (cycleId: string, width: number) => void;
};

// Defaults: large-v3 (spec §6.4 default) + auto language + auto speaker count.
// localStorage overrides them.
const LS_MODEL = "ilab.asr.model";
const LS_LANG = "ilab.asr.lang";
const LS_SPEAKERS = "ilab.asr.speakers";
function lsGet(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore (private mode / SSR) */
  }
}

// Chat panel persistence: one localStorage key per map (cycleId → value). A small JSON
// blob beats an app_setting round-trip for pure UI state (matches the ASR-pref rationale).
const LS_CHAT_OPEN = "ilab.chat.open";
const LS_CHAT_WIDTH = "ilab.chat.width";
const CHAT_WIDTH_DEFAULT = 32; // % of the horizontal split
function lsGetMap<V>(key: string): Record<string, V> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, V>) : {};
  } catch {
    return {};
  }
}
function lsSetMap<V>(key: string, value: Record<string, V>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),

  newCycleRequest: 0,
  requestNewCycle: () => set((s) => ({ newCycleRequest: s.newCycleRequest + 1 })),

  asrModelId: lsGet(LS_MODEL, "large-v3"),
  asrLanguage: lsGet(LS_LANG, "auto"),
  setAsrModelId: (id) => {
    lsSet(LS_MODEL, id);
    set({ asrModelId: id });
  },
  setAsrLanguage: (lang) => {
    lsSet(LS_LANG, lang);
    set({ asrLanguage: lang });
  },

  asrExpectedSpeakers: lsGet(LS_SPEAKERS, "auto"),
  setAsrExpectedSpeakers: (v) => {
    lsSet(LS_SPEAKERS, v);
    set({ asrExpectedSpeakers: v });
  },

  chatOpenByCycle: lsGetMap<boolean>(LS_CHAT_OPEN),
  chatWidthByCycle: lsGetMap<number>(LS_CHAT_WIDTH),
  chatOpenRequest: 0,
  isChatOpen: (cycleId) => get().chatOpenByCycle[cycleId] ?? false,
  setChatOpen: (cycleId, open) =>
    set((s) => {
      const next = { ...s.chatOpenByCycle, [cycleId]: open };
      lsSetMap(LS_CHAT_OPEN, next);
      return { chatOpenByCycle: next };
    }),
  toggleChat: (cycleId) =>
    set((s) => {
      const next = { ...s.chatOpenByCycle, [cycleId]: !(s.chatOpenByCycle[cycleId] ?? false) };
      lsSetMap(LS_CHAT_OPEN, next);
      return { chatOpenByCycle: next };
    }),
  requestChatOpen: () => set((s) => ({ chatOpenRequest: s.chatOpenRequest + 1 })),
  chatWidth: (cycleId) => get().chatWidthByCycle[cycleId] ?? CHAT_WIDTH_DEFAULT,
  setChatWidth: (cycleId, width) =>
    set((s) => {
      const next = { ...s.chatWidthByCycle, [cycleId]: width };
      lsSetMap(LS_CHAT_WIDTH, next);
      return { chatWidthByCycle: next };
    }),
}));
