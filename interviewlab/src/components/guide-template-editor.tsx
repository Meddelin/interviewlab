import { useEffect, useRef, useState } from "react";
import {
  FlaskConical,
  GripVertical,
  HelpCircle,
  Layers,
  ListChecks,
  Plus,
  Target,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { GuideTemplate, TemplateItem } from "@/lib/tauri";
import { templateIsEmpty } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

const STR = {
  ru: {
    remove: "Удалить",
    removeBlock: "Удалить блок",
    // Preview titles
    pHypotheses: "Гипотезы",
    pTasks: "Задачи интервью",
    pQualifying: "Квалифицирующие вопросы",
    pMain: "Основная часть вопросов",
    pHypQuestions: "Вопросы по гипотезам",
    // Editor blocks
    hypothesesTitle: "Гипотезы",
    hypothesesDesc:
      "Гипотезы для проверки. Синтез возвращает по каждой вердикт (подтверждена / частично / опровергнута / неоднозначно).",
    addHypothesis: "Добавить гипотезу",
    hypothesisPlaceholder: "напр. Новые аккаунты отваливаются, потому что настройка занимает слишком много времени",
    tasksTitle: "Задачи интервью",
    tasksDesc:
      "Исследовательские задачи, которые должно решить это интервью. Они становятся целями синтеза (G1, G2…), по которым выравниваются findings и дифф.",
    addTask: "Добавить задачу",
    taskPlaceholder: "напр. Понять, что блокирует активацию",
    qualifyingTitle: "Квалифицирующие вопросы",
    qualifyingDesc: "Отсеивающие вопросы, чтобы убедиться, что респондент подходит под целевую аудиторию.",
    addQualifying: "Добавить квалифицирующий вопрос",
    qualifyingPlaceholder: "напр. Какая у вас роль в команде?",
    mainTitle: "Основная часть вопросов",
    mainDesc:
      "Основные вопросы, сгруппированные в тематические блоки. Добавьте блок под каждую тему, затем добавляйте в него вопросы.",
    themePlaceholder: (n: number) => `Тема ${n} (напр. Онбординг)`,
    mainQuestionPlaceholder: "напр. Проведите меня по вашему первому дню",
    addQuestion: "Добавить вопрос",
    addBlock: "Добавить блок вопросов",
    hypQTitle: "Вопросы по гипотезам",
    hypQDesc: "Вопросы, нацеленные прямо на проверку гипотез выше.",
    addHypQuestion: "Добавить вопрос по гипотезе",
    hypQPlaceholder: "напр. Заплатили бы вы при регистрации?",
  },
  en: {
    remove: "Remove",
    removeBlock: "Remove block",
    pHypotheses: "Hypotheses",
    pTasks: "Interview tasks",
    pQualifying: "Qualifying questions",
    pMain: "Main questions",
    pHypQuestions: "Hypothesis questions",
    hypothesesTitle: "Hypotheses",
    hypothesesDesc:
      "Hypotheses to validate. The synthesis returns a verdict (confirmed / partial / refuted / inconclusive) for each.",
    addHypothesis: "Add hypothesis",
    hypothesisPlaceholder: "e.g. New accounts churn because setup takes too long",
    tasksTitle: "Interview tasks",
    tasksDesc:
      "Research tasks this interview should solve. These become the synthesis goals (G1, G2…) the findings + diff align on.",
    addTask: "Add task",
    taskPlaceholder: "e.g. Understand the activation blocker",
    qualifyingTitle: "Qualifying questions",
    qualifyingDesc: "Screening questions to confirm the respondent fits the target.",
    addQualifying: "Add qualifying question",
    qualifyingPlaceholder: "e.g. What's your role on the team?",
    mainTitle: "Main questions",
    mainDesc:
      "The core questions, grouped into themed blocks. Add a block per theme, then add questions inside it.",
    themePlaceholder: (n: number) => `Theme ${n} (e.g. Onboarding)`,
    mainQuestionPlaceholder: "e.g. Walk me through your first day",
    addQuestion: "Add question",
    addBlock: "Add question block",
    hypQTitle: "Hypothesis questions",
    hypQDesc: "Questions aimed directly at testing the hypotheses above.",
    addHypQuestion: "Add hypothesis question",
    hypQPlaceholder: "e.g. Would you have paid at signup?",
  },
};

// The structured, templated-guide editor (req: "шаблонизировать гайд"). Five fixed blocks the
// user fills by clicking "+ add": hypotheses to validate, research tasks (= the synthesis
// goals), qualifying questions, main questions grouped into themed sub-blocks, and hypothesis
// questions. It edits a local row model (stable React keys, ids stamped server-side on save)
// and reports a GuideTemplate up via onChange (item ids left blank — the backend normalizes).

// A local editable row — `key` is a stable client id for React (the H/G/Q ids are assigned
// server-side, so we can't key on them while typing/reordering).
type Row = { key: string; text: string };
type BlockRow = { key: string; title: string; questions: Row[] };

type LocalState = {
  hypotheses: Row[];
  tasks: Row[];
  qualifying: Row[];
  mainBlocks: BlockRow[];
  hypothesisQuestions: Row[];
};

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `r${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRows(items: { text: string }[]): Row[] {
  return items.map((it) => ({ key: nextKey(), text: it.text }));
}

function fromTemplate(t: GuideTemplate): LocalState {
  return {
    hypotheses: toRows(t.hypotheses),
    tasks: toRows(t.tasks),
    qualifying: toRows(t.qualifying_questions),
    mainBlocks: t.main_blocks.map((b) => ({
      key: nextKey(),
      title: b.title,
      questions: toRows(b.questions),
    })),
    hypothesisQuestions: toRows(t.hypothesis_questions),
  };
}

// Build the GuideTemplate to persist. Item ids are left "" — the backend stamps stable
// H/G/Q ids deterministically. Blank rows are dropped server-side too, but we keep them in the
// editor so a freshly-added empty row doesn't vanish mid-typing.
function toTemplate(s: LocalState): GuideTemplate {
  const items = (rows: Row[]) => rows.map((r) => ({ id: "", text: r.text }));
  return {
    hypotheses: items(s.hypotheses),
    tasks: items(s.tasks),
    qualifying_questions: items(s.qualifying),
    main_blocks: s.mainBlocks.map((b) => ({ title: b.title, questions: items(b.questions) })),
    hypothesis_questions: items(s.hypothesisQuestions),
  };
}

// One editable item row: an auto-growing textarea + a delete button. The `idLabel` (H1/G1/Q1…)
// is shown read-only so the user sees the stable ids the synthesis/diff will reference.
function ItemRow({
  value,
  idLabel,
  placeholder,
  onChange,
  onRemove,
}: {
  value: string;
  idLabel?: string;
  placeholder: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  const t = useT(STR);
  return (
    <div className="group flex items-start gap-2">
      <GripVertical className="mt-2 size-3.5 shrink-0 text-muted-foreground/30" aria-hidden />
      {idLabel && (
        <span className="mt-1.5 w-7 shrink-0 font-numeric text-[11px] text-muted-foreground/70">
          {idLabel}
        </span>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={1}
        className="min-h-9 flex-1 resize-y py-1.5 text-[13px]"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t.remove}
        onClick={onRemove}
        className="mt-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

// A fixed block (hypotheses / tasks / qualifying / hypothesis questions): heading + items +
// an "+ add" button. `idFor(i)` renders the stable id preview (H1.., G1.., or Q numbering).
function Block({
  icon: Icon,
  title,
  description,
  addLabel,
  placeholder,
  rows,
  idFor,
  onAdd,
  onChange,
  onRemove,
}: {
  icon: typeof Target;
  title: string;
  description: string;
  addLabel: string;
  placeholder: string;
  rows: Row[];
  idFor?: (i: number) => string;
  onAdd: () => void;
  onChange: (i: number, v: string) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-4 text-primary/80" aria-hidden />
          {title}
        </h3>
        <p className="pl-6 text-xs text-muted-foreground">{description}</p>
      </div>
      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <ItemRow
              key={r.key}
              value={r.text}
              idLabel={idFor?.(i)}
              placeholder={placeholder}
              onChange={(v) => onChange(i, v)}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="w-fit"
      >
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </section>
  );
}

// A compact, READ-ONLY preview of a structured guide template — the five blocks with their
// stable ids (H/G/Q). Used where we want to show the template's SHAPE (e.g. the cycle Overview)
// rather than the flat rendered markdown. Item ids come straight from the stored, normalized
// template, so no renumbering is needed here.
function PreviewBlock({
  icon: Icon,
  title,
  items,
}: {
  icon: typeof Target;
  title: string;
  items: TemplateItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5 text-primary/70" aria-hidden />
        {title}
        <span className="font-numeric text-foreground/60">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 py-0.5 font-numeric text-[10px] text-muted-foreground">
              {it.id}
            </span>
            <span className="text-foreground/80">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GuideTemplatePreview({ template }: { template: GuideTemplate }) {
  const t = useT(STR);
  if (templateIsEmpty(template)) return null;
  const mainQuestions = template.main_blocks.flatMap((b) => b.questions);
  return (
    <div className="flex flex-col gap-3">
      <PreviewBlock icon={FlaskConical} title={t.pHypotheses} items={template.hypotheses} />
      <PreviewBlock icon={Target} title={t.pTasks} items={template.tasks} />
      <PreviewBlock icon={ListChecks} title={t.pQualifying} items={template.qualifying_questions} />
      {/* Main questions: show per themed block so the structure reads. */}
      {mainQuestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Layers className="size-3.5 text-primary/70" aria-hidden />
            {t.pMain}
            <span className="font-numeric text-foreground/60">{mainQuestions.length}</span>
          </div>
          <div className="flex flex-col gap-2 pl-1">
            {template.main_blocks.map(
              (b, bi) =>
                b.questions.length > 0 && (
                  <div key={bi} className="flex flex-col gap-1">
                    {b.title.trim() && (
                      <span className="text-[11px] font-medium text-foreground/70">{b.title}</span>
                    )}
                    <ul className="flex flex-col gap-1">
                      {b.questions.map((it) => (
                        <li key={it.id} className="flex items-start gap-2 text-xs">
                          <span className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 py-0.5 font-numeric text-[10px] text-muted-foreground">
                            {it.id}
                          </span>
                          <span className="text-foreground/80">{it.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
          </div>
        </div>
      )}
      <PreviewBlock icon={HelpCircle} title={t.pHypQuestions} items={template.hypothesis_questions} />
    </div>
  );
}

export function GuideTemplateEditor({
  template,
  onChange,
}: {
  template: GuideTemplate;
  onChange: (t: GuideTemplate) => void;
}) {
  const tx = useT(STR);
  // Seed the local row model once (and again only when the caller swaps to a different guide,
  // which it signals by remounting via a `key`). The editor owns the live state after that.
  const [state, setState] = useState<LocalState>(() => fromTemplate(template));

  // Report changes up. We skip the very first effect run so we don't echo the seed straight
  // back (which would mark the parent dirty on open).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    onChange(toTemplate(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Question numbering preview: qualifying, then each main block, then hypothesis questions
  // share ONE global Q counter (matches the backend), so the user sees Q1, Q2, … in order.
  const qualCount = state.qualifying.length;
  const mainCounts = state.mainBlocks.map((b) => b.questions.length);
  const mainStart = (blockIdx: number) =>
    1 + qualCount + mainCounts.slice(0, blockIdx).reduce((a, b) => a + b, 0);
  const hypQStart = 1 + qualCount + mainCounts.reduce((a, b) => a + b, 0);

  // --- row mutators (immutable updates) ---
  const addRow = (field: "hypotheses" | "tasks" | "qualifying" | "hypothesisQuestions") =>
    setState((s) => ({ ...s, [field]: [...s[field], { key: nextKey(), text: "" }] }));
  const changeRow = (
    field: "hypotheses" | "tasks" | "qualifying" | "hypothesisQuestions",
    i: number,
    v: string,
  ) =>
    setState((s) => ({
      ...s,
      [field]: s[field].map((r, idx) => (idx === i ? { ...r, text: v } : r)),
    }));
  const removeRow = (
    field: "hypotheses" | "tasks" | "qualifying" | "hypothesisQuestions",
    i: number,
  ) => setState((s) => ({ ...s, [field]: s[field].filter((_, idx) => idx !== i) }));

  // --- main block mutators ---
  const addBlock = () =>
    setState((s) => ({
      ...s,
      mainBlocks: [...s.mainBlocks, { key: nextKey(), title: "", questions: [] }],
    }));
  const removeBlock = (bi: number) =>
    setState((s) => ({ ...s, mainBlocks: s.mainBlocks.filter((_, idx) => idx !== bi) }));
  const changeBlockTitle = (bi: number, title: string) =>
    setState((s) => ({
      ...s,
      mainBlocks: s.mainBlocks.map((b, idx) => (idx === bi ? { ...b, title } : b)),
    }));
  const addBlockQuestion = (bi: number) =>
    setState((s) => ({
      ...s,
      mainBlocks: s.mainBlocks.map((b, idx) =>
        idx === bi ? { ...b, questions: [...b.questions, { key: nextKey(), text: "" }] } : b,
      ),
    }));
  const changeBlockQuestion = (bi: number, qi: number, v: string) =>
    setState((s) => ({
      ...s,
      mainBlocks: s.mainBlocks.map((b, idx) =>
        idx === bi
          ? { ...b, questions: b.questions.map((r, j) => (j === qi ? { ...r, text: v } : r)) }
          : b,
      ),
    }));
  const removeBlockQuestion = (bi: number, qi: number) =>
    setState((s) => ({
      ...s,
      mainBlocks: s.mainBlocks.map((b, idx) =>
        idx === bi ? { ...b, questions: b.questions.filter((_, j) => j !== qi) } : b,
      ),
    }));

  return (
    <div className="flex flex-col gap-4">
      <Block
        icon={FlaskConical}
        title={tx.hypothesesTitle}
        description={tx.hypothesesDesc}
        addLabel={tx.addHypothesis}
        placeholder={tx.hypothesisPlaceholder}
        rows={state.hypotheses}
        idFor={(i) => `H${i + 1}`}
        onAdd={() => addRow("hypotheses")}
        onChange={(i, v) => changeRow("hypotheses", i, v)}
        onRemove={(i) => removeRow("hypotheses", i)}
      />

      <Block
        icon={Target}
        title={tx.tasksTitle}
        description={tx.tasksDesc}
        addLabel={tx.addTask}
        placeholder={tx.taskPlaceholder}
        rows={state.tasks}
        idFor={(i) => `G${i + 1}`}
        onAdd={() => addRow("tasks")}
        onChange={(i, v) => changeRow("tasks", i, v)}
        onRemove={(i) => removeRow("tasks", i)}
      />

      <Block
        icon={ListChecks}
        title={tx.qualifyingTitle}
        description={tx.qualifyingDesc}
        addLabel={tx.addQualifying}
        placeholder={tx.qualifyingPlaceholder}
        rows={state.qualifying}
        idFor={(i) => `Q${i + 1}`}
        onAdd={() => addRow("qualifying")}
        onChange={(i, v) => changeRow("qualifying", i, v)}
        onRemove={(i) => removeRow("qualifying", i)}
      />

      {/* Main questions — themed sub-blocks the user can add at will. */}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Layers className="size-4 text-primary/80" aria-hidden />
            {tx.mainTitle}
          </h3>
          <p className="pl-6 text-xs text-muted-foreground">
            {tx.mainDesc}
          </p>
        </div>

        {state.mainBlocks.map((b, bi) => (
          <div key={b.key} className="flex flex-col gap-2 rounded-md border border-border/70 bg-background/40 p-3">
            <div className="flex items-center gap-2">
              <Input
                value={b.title}
                onChange={(e) => changeBlockTitle(bi, e.target.value)}
                placeholder={tx.themePlaceholder(bi + 1)}
                className="h-8 flex-1 text-[13px] font-medium"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={tx.removeBlock}
                onClick={() => removeBlock(bi)}
                className="text-muted-foreground/60 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {b.questions.length > 0 && (
              <div className="flex flex-col gap-1.5 pl-1">
                {b.questions.map((r, qi) => (
                  <ItemRow
                    key={r.key}
                    value={r.text}
                    idLabel={`Q${mainStart(bi) + qi}`}
                    placeholder={tx.mainQuestionPlaceholder}
                    onChange={(v) => changeBlockQuestion(bi, qi, v)}
                    onRemove={() => removeBlockQuestion(bi, qi)}
                  />
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addBlockQuestion(bi)}
              className="w-fit"
            >
              <Plus className="size-3.5" />
              {tx.addQuestion}
            </Button>
          </div>
        ))}

        <Button type="button" variant="secondary" size="sm" onClick={addBlock} className="w-fit">
          <Plus className="size-3.5" />
          {tx.addBlock}
        </Button>
      </section>

      <Block
        icon={HelpCircle}
        title={tx.hypQTitle}
        description={tx.hypQDesc}
        addLabel={tx.addHypQuestion}
        placeholder={tx.hypQPlaceholder}
        rows={state.hypothesisQuestions}
        idFor={(i) => `Q${hypQStart + i}`}
        onAdd={() => addRow("hypothesisQuestions")}
        onChange={(i, v) => changeRow("hypothesisQuestions", i, v)}
        onRemove={(i) => removeRow("hypothesisQuestions", i)}
      />
    </div>
  );
}
