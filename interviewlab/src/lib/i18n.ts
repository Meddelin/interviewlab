// Tiny, dependency-free i18n for the ru/en UI.
//
// Pattern (per component — keeps strings co-located, so files localize independently with no
// shared dictionary to fight over):
//
//   import { useT } from "@/lib/i18n";
//   const STR = {
//     ru: { save: "Сохранить", title: "Настройки" },
//     en: { save: "Save",      title: "Settings" },
//   } as const;
//   function Foo() {
//     const t = useT(STR);
//     return <button title={t.title}>{t.save}</button>;
//   }
//
// For non-hook contexts (module scope, event helpers outside a component) use `tr(STR)`, which
// reads the current language straight from the store. The language itself lives in ui-store
// (`uiLang`, persisted) — separate from `asrLanguage` (the transcription language).
import { useUiStore } from "@/lib/ui-store";

export type Lang = "ru" | "en";

// Widen the literal types produced by an `as const` string table to their base types, so the
// `ru` and `en` branches can hold different literals (e.g. "Готово" vs "Ready") yet still be
// required to share the same SHAPE. Without this, inference pins the slice type to one branch's
// literals and the other branch fails to type-check.
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends (...args: infer A) => infer R
        ? (...args: A) => Widen<R>
        : T extends readonly (infer E)[]
          ? readonly Widen<E>[]
          : T extends object
            ? { -readonly [K in keyof T]: Widen<T[K]> }
            : T;

// A {ru, en} table: `en` defines the shape, `ru` must structurally match it (widened).
type Table<T> = { en: T; ru: Widen<T> };

// Subscribe a component to the current UI language.
export function useUiLang(): Lang {
  return useUiStore((s) => s.uiLang);
}

// Hook: pick the current-language slice of a {ru, en} table. Re-renders on language change.
export function useT<T>(table: Table<T>): Widen<T> {
  return table[useUiStore((s) => s.uiLang)] as Widen<T>;
}

// Non-reactive read (outside React / inside callbacks): pick the current-language slice.
export function tr<T>(table: Table<T>): Widen<T> {
  return table[useUiStore.getState().uiLang] as Widen<T>;
}

// Current language without subscribing (for non-hook callers).
export function currentLang(): Lang {
  return useUiStore.getState().uiLang;
}
