import { Button } from "@/components/ui/button";
import { useUiStore } from "@/lib/ui-store";

// Quiet RU/EN switch for the top header, next to the theme toggle. Flips the persisted
// `uiLang` that drives every component's string table (see lib/i18n.ts).
export function LanguageToggle() {
  const uiLang = useUiStore((s) => s.uiLang);
  const setUiLang = useUiStore((s) => s.setUiLang);
  const next = uiLang === "ru" ? "en" : "ru";
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 font-numeric text-[11px] font-semibold uppercase text-muted-foreground hover:text-foreground"
      onClick={() => setUiLang(next)}
      aria-label={uiLang === "ru" ? "Switch to English" : "Переключить на русский"}
      title={uiLang === "ru" ? "Switch to English" : "Переключить на русский"}
    >
      {uiLang}
    </Button>
  );
}
