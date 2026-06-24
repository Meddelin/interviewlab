import { useEffect, useRef, type ReactNode } from "react";
import {
  Plate,
  PlateContent,
  usePlateEditor,
  useEditorRef,
  useEditorReadOnly,
  useEditorSelector,
  useMarkToolbarButton,
  useMarkToolbarButtonState,
  useReadOnly,
  type PlateElementProps,
  type PlateLeafProps,
  type RenderNodeWrapper,
  PlateElement,
  PlateLeaf,
} from "platejs/react";
import {
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
  StrikethroughPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
} from "@platejs/basic-nodes/react";
import {
  ListPlugin,
  useListToolbarButton,
  useListToolbarButtonState,
  useTodoListElement,
  useTodoListElementState,
} from "@platejs/list/react";
import { isOrderedList } from "@platejs/list";
import { IndentPlugin } from "@platejs/indent/react";
import { LinkPlugin, useLinkToolbarButton, useLinkToolbarButtonState } from "@platejs/link/react";
import {
  TablePlugin,
  TableRowPlugin,
  TableCellPlugin,
  TableCellHeaderPlugin,
} from "@platejs/table/react";
import { CodeBlockPlugin, CodeLinePlugin, CodeSyntaxPlugin } from "@platejs/code-block/react";
import { MarkdownPlugin } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import { all, createLowlight } from "lowlight";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List as ListIcon,
  ListOrdered,
  ListChecks,
  Quote,
  Minus,
  Code2,
  Table as TableIcon,
  Plus,
  Trash2,
  Columns2,
  Rows2,
  Undo2,
  Redo2,
  RemoveFormatting,
  Link as LinkIcon,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Plate markdown editor (M10a, reuse-landscape.md: "Синтез/markdown → Plate").
//
// Plate v53 (the unified `platejs` package). We wire the feature set a research guide needs —
// headings, bold/italic/underline/strikethrough, inline code, blockquotes, bulleted + numbered
// + task lists (@platejs/list, indent-based), links (@platejs/link), GFM tables
// (@platejs/table), horizontal-rule dividers + fenced code blocks (@platejs/code-block) — plus
// the @platejs/markdown plugin so the guide round-trips to/from the `content_md` column.
// remark-gfm enables lists/tables/strikethrough/task-lists on parse, so every block here
// survives serialize()->deserialize() as GFM markdown (`| a | b |`, `- [ ]`, `---`, fenced ```).
//
// Lists are the v53 *indent* model: flat `p` nodes carrying `listStyleType` + `indent`. The
// BaseListPlugin ships its own `render.belowNodes` that wraps each into real <ul>/<ol>/<li>
// DOM (with the right list-style-type), so the existing `[&_ul]`/`[&_ol]` CSS below still
// styles them. Task lists ride the same model with `listStyleType: 'todo'` (KEYS.listTodo) and
// a `checked` prop; we render an interactive checkbox via the @platejs/list todo hooks below.
// @platejs/markdown detects these props and serializes/deserializes them to/from markdown
// natively (lists/tasks/tables/hr/code-blocks).
//
// The editor is UNCONTROLLED w.r.t. markdown: we seed it once from `value` and report edits
// back out as a markdown string via onChange (serialize on each change). Styling is
// element-level (renderers below) to keep the Linear dark aesthetic — no Plate default CSS.

// lowlight powers code-block syntax highlighting. `all` registers the common grammars; the
// CodeSyntaxLeaf renderer below applies the hljs token classes (we keep it minimal — the
// muted block bg reads fine even without a full hljs theme).
const lowlight = createLowlight(all);

// ── Element + leaf renderers (Linear-styled, no external Plate theme) ──────────
function H1Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h1"
      className="mt-5 mb-2 text-lg font-semibold tracking-[-0.01em] text-foreground first:mt-0"
      {...props}
    />
  );
}
function H2Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h2"
      className="mt-5 mb-1.5 text-sm font-semibold tracking-tight text-foreground first:mt-0"
      {...props}
    />
  );
}
function H3Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h3"
      className="mt-4 mb-1 text-[13px] font-semibold text-foreground/90 first:mt-0"
      {...props}
    />
  );
}
function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-2 border-l-2 border-border-strong pl-3 text-muted-foreground italic"
      {...props}
    />
  );
}
function LinkElement(props: PlateElementProps) {
  // Inline link: BaseLinkPlugin supplies href/target via node props; render as an <a> so it's
  // styled (and Ctrl/Cmd-clickable). Matches the [&_a] CSS on PlateContent below.
  return (
    <PlateElement
      as="a"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      {...props}
    />
  );
}
function HrElement(props: PlateElementProps) {
  // Divider (`---`). Void node: the <hr> is the visible mark, Plate's spacer children carry the
  // selection. contentEditable={false} on the rule keeps the caret out of it.
  return (
    <PlateElement {...props}>
      <div contentEditable={false} className="py-2">
        <hr className="border-0 border-t border-border" />
      </div>
      {props.children}
    </PlateElement>
  );
}

// List rendering (belowNodes override). The v53 list model is flat `p` nodes carrying
// `listStyleType` + `indent`; the plugin's render.belowNodes wraps each into <ul>/<ol>/<li>.
// We override it (vs. the stock renderer) so we can render an interactive checkbox + strikethrough
// for `listStyleType: 'todo'` (task lists) while keeping plain <ul>/<ol>/<li> for disc/decimal.
const ListContainer: RenderNodeWrapper = (props) => {
  if (!(props.element as any).listStyleType) return undefined;
  return (childProps) => <ListWrapper {...childProps} />;
};

function ListWrapper(props: PlateElementProps & { lineBreakBadge?: ReactNode }) {
  const el = props.element as any;
  const listStyleType: string = el.listStyleType;
  const Wrapper = isOrderedList(props.element) ? "ol" : "ul";
  const isTodo = listStyleType === "todo";
  return (
    <Wrapper className="relative m-0 p-0" style={{ listStyleType }} start={el.listStart}>
      {isTodo && <TodoMarker {...props} />}
      {isTodo ? (
        <li className={cn("list-none", el.checked && "text-muted-foreground line-through")}>
          {props.children}
          {props.lineBreakBadge}
        </li>
      ) : (
        <li>
          {props.children}
          {props.lineBreakBadge}
        </li>
      )}
    </Wrapper>
  );
}

// Task-list checkbox: interactive marker rendered before each `listStyleType: 'todo'` item.
// useTodoListElement supplies {checked, onCheckedChange, onMouseDown}; we drive a plain
// styled <input type=checkbox> off it (no extra dep). contentEditable={false} keeps the caret
// in the text, not the box.
function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();
  return (
    <div contentEditable={false} className="absolute top-[0.2em] -left-5 select-none">
      <input
        type="checkbox"
        checked={checkboxProps.checked}
        onChange={(e) => checkboxProps.onCheckedChange(e.target.checked)}
        onMouseDown={checkboxProps.onMouseDown}
        disabled={readOnly}
        className={cn(
          "size-3.5 cursor-pointer rounded-[3px] border border-border-strong bg-transparent accent-primary",
          readOnly && "pointer-events-none",
        )}
      />
    </div>
  );
}

// Table renderers — real <table>/<tr>/<td>/<th>; thin hairline borders to match the bar.
function TableElement(props: PlateElementProps) {
  return (
    <PlateElement {...props}>
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <tbody>{props.children}</tbody>
        </table>
      </div>
    </PlateElement>
  );
}
function TableRowElement(props: PlateElementProps) {
  return <PlateElement as="tr" {...props} />;
}
function TableCellElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="td"
      className="border border-border px-2 py-1 align-top"
      {...props}
    />
  );
}
function TableCellHeaderElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="th"
      className="border border-border bg-secondary/40 px-2 py-1 text-left font-semibold"
      {...props}
    />
  );
}

// Code block renderers — fenced multi-line ```. Distinct from the inline `code` leaf above.
function CodeBlockElement(props: PlateElementProps) {
  return (
    <PlateElement {...props}>
      <pre className="my-2 overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-numeric text-[12.5px] leading-relaxed text-foreground/90">
        <code>{props.children}</code>
      </pre>
    </PlateElement>
  );
}
function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} />;
}
function CodeSyntaxLeaf(props: PlateLeafProps) {
  // lowlight decorations land as hljs token classes on the leaf; render plainly (the muted
  // block bg already reads). Keeping a span here lets a theme be dropped in later if wanted.
  return <PlateLeaf {...props} />;
}
function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      as="code"
      className="rounded bg-muted px-1 py-0.5 font-numeric text-[0.85em] text-foreground/90"
      {...props}
    />
  );
}

// ── Toolbar (Linear bar: quiet sticky hairline, lucide buttons, accent active state) ──
function ToolbarButton({
  active,
  disabled,
  onClick,
  onMouseDown,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      // Prevent the editor losing selection on mousedown (so toggles apply to the selection).
      onMouseDown={(e) => {
        e.preventDefault();
        onMouseDown?.(e);
      }}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-secondary hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:size-4",
        active && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <div className="mx-0.5 h-5 w-px self-center bg-border" aria-hidden />;
}

// Mark buttons (bold/italic/underline/strikethrough/code) — official v53 mark hooks.
function MarkButton({ nodeType, title, children }: { nodeType: string; title: string; children: ReactNode }) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props } = useMarkToolbarButton(state);
  return (
    <ToolbarButton active={props.pressed} onClick={props.onClick} onMouseDown={props.onMouseDown} title={title}>
      {children}
    </ToolbarButton>
  );
}

// Block buttons (H1/H2/H3/blockquote) — toggle via the per-plugin tf.<key>.toggle(),
// active state read from the selection's block type via a Plate selector.
function BlockButton({ pluginKey, title, children }: { pluginKey: string; title: string; children: ReactNode }) {
  const editor = useEditorRef();
  const active = useEditorSelector(
    (ed) => ed.api.some({ match: { type: ed.getType(pluginKey) } }),
    [pluginKey],
  );
  return (
    <ToolbarButton
      active={active}
      // ponytail: each basic-node plugin exposes tf.<key>.toggle() but the union isn't
      // string-indexable in Plate's types — a single `as any` here beats per-key wiring.
      onClick={() => (editor.tf as any)[pluginKey]?.toggle()}
      title={title}
    >
      {children}
    </ToolbarButton>
  );
}

// List buttons (bulleted/numbered/task) — official v53 list hook; nodeType is the listStyleType
// ('disc' | 'decimal' | 'todo'). The todo case toggles the same indent-list model with a
// `checked` prop, rendered as an interactive checkbox (TodoMarker above).
function ListButton({ nodeType, title, children }: { nodeType: string; title: string; children: ReactNode }) {
  const state = useListToolbarButtonState({ nodeType });
  const { props } = useListToolbarButton(state);
  return (
    <ToolbarButton active={props.pressed} onClick={props.onClick} onMouseDown={props.onMouseDown} title={title}>
      {children}
    </ToolbarButton>
  );
}

// Link button — official v53 link hook (opens the floating link UI / wraps the selection).
function LinkButton() {
  const state = useLinkToolbarButtonState();
  const { props } = useLinkToolbarButton(state);
  return (
    <ToolbarButton active={props.pressed} onClick={props.onClick} onMouseDown={props.onMouseDown} title="Link">
      <LinkIcon />
    </ToolbarButton>
  );
}

// Divider button — HorizontalRulePlugin has no insert helper; insert the void hr node and a
// trailing paragraph so the caret has somewhere to land after it.
function DividerButton() {
  const editor = useEditorRef();
  return (
    <ToolbarButton
      title="Divider"
      onClick={() => {
        const hrType = editor.getType(HorizontalRulePlugin.key);
        editor.tf.insertNodes(
          [
            { type: hrType, children: [{ text: "" }] },
            { type: editor.getType("p"), children: [{ text: "" }] },
          ],
          { select: true },
        );
      }}
    >
      <Minus />
    </ToolbarButton>
  );
}

// Code-block button — CodeBlockPlugin binds its toggle under tf.<key>.toggle() (key is
// 'code_block'), same shape as the basic-node block plugins. Wraps/unwraps a fenced block.
function CodeBlockButton() {
  const editor = useEditorRef();
  const active = useEditorSelector(
    (ed) => ed.api.some({ match: { type: ed.getType(CodeBlockPlugin.key) } }),
    [],
  );
  return (
    <ToolbarButton
      active={active}
      title="Code block"
      onClick={() => (editor.tf as any)[CodeBlockPlugin.key]?.toggle()}
    >
      <Code2 />
    </ToolbarButton>
  );
}

// Table menu — single button opens a small popover with insert + row/column ops (the bar would
// be too long with six standalone buttons). Uses the v53 namespaced transforms:
// tf.insert.table / tf.insert.tableRow|tableColumn / tf.remove.tableRow|tableColumn.
function TableMenu() {
  const editor = useEditorRef();
  // ponytail: table transforms (tf.insert.table / tf.remove.tableRow …) exist at runtime via
  // TablePlugin but aren't on useEditorRef's base tf type — one `as any` beats per-call casts.
  const tf = editor.tf as any;
  const inTable = useEditorSelector(
    (ed) => ed.api.some({ match: { type: ed.getType(TablePlugin.key) } }),
    [],
  );
  const Item = ({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/90 transition-colors hover:bg-secondary [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
    >
      {icon}
      {label}
    </button>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Table"
          aria-label="Table"
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-secondary hover:text-foreground [&_svg]:size-4",
            inTable && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
          )}
        >
          <TableIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48">
        <Item
          icon={<Plus />}
          label="Insert table"
          onClick={() => tf.insert.table({ rowCount: 3, colCount: 3, header: true })}
        />
        {inTable && (
          <>
            <div className="my-1 h-px bg-border" />
            <Item icon={<Rows2 />} label="Row above" onClick={() => tf.insert.tableRow({ before: true })} />
            <Item icon={<Rows2 />} label="Row below" onClick={() => tf.insert.tableRow()} />
            <Item icon={<Columns2 />} label="Column left" onClick={() => tf.insert.tableColumn({ before: true })} />
            <Item icon={<Columns2 />} label="Column right" onClick={() => tf.insert.tableColumn()} />
            <div className="my-1 h-px bg-border" />
            <Item icon={<Trash2 />} label="Delete row" onClick={() => tf.remove.tableRow()} />
            <Item icon={<Trash2 />} label="Delete column" onClick={() => tf.remove.tableColumn()} />
            <Item icon={<Trash2 />} label="Delete table" onClick={() => tf.remove.table()} />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// History (undo/redo) — disabled when the respective stack is empty. We read the stacks via a
// selector so the buttons re-evaluate on each change.
function HistoryButton({ kind }: { kind: "undo" | "redo" }) {
  const editor = useEditorRef();
  const canRun = useEditorSelector(
    (ed) => (kind === "undo" ? ed.history.undos.length > 0 : ed.history.redos.length > 0),
    [kind],
  );
  return (
    <ToolbarButton
      title={kind === "undo" ? "Undo" : "Redo"}
      disabled={!canRun}
      onClick={() => (kind === "undo" ? editor.tf.undo() : editor.tf.redo())}
    >
      {kind === "undo" ? <Undo2 /> : <Redo2 />}
    </ToolbarButton>
  );
}

// Clear formatting — remove all marks from the selection (nice-to-have).
function ClearFormattingButton() {
  const editor = useEditorRef();
  return (
    <ToolbarButton title="Clear formatting" onClick={() => editor.tf.removeMarks()}>
      <RemoveFormatting />
    </ToolbarButton>
  );
}

function EditorToolbar() {
  // Hide the toolbar entirely in read-only mode (consumers pass readOnly).
  const readOnly = useEditorReadOnly();
  if (readOnly) return null;
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-lg border-b border-border bg-card/80 px-1.5 py-1 backdrop-blur-sm">
      {/* marks */}
      <MarkButton nodeType="bold" title="Bold">
        <Bold />
      </MarkButton>
      <MarkButton nodeType="italic" title="Italic">
        <Italic />
      </MarkButton>
      <MarkButton nodeType="underline" title="Underline">
        <Underline />
      </MarkButton>
      <MarkButton nodeType="strikethrough" title="Strikethrough">
        <Strikethrough />
      </MarkButton>
      <MarkButton nodeType="code" title="Inline code">
        <Code />
      </MarkButton>
      <ToolbarSeparator />
      {/* headings */}
      <BlockButton pluginKey="h1" title="Heading 1">
        <Heading1 />
      </BlockButton>
      <BlockButton pluginKey="h2" title="Heading 2">
        <Heading2 />
      </BlockButton>
      <BlockButton pluginKey="h3" title="Heading 3">
        <Heading3 />
      </BlockButton>
      <ToolbarSeparator />
      {/* lists + tasks */}
      <ListButton nodeType="disc" title="Bulleted list">
        <ListIcon />
      </ListButton>
      <ListButton nodeType="decimal" title="Numbered list">
        <ListOrdered />
      </ListButton>
      <ListButton nodeType="todo" title="Task list">
        <ListChecks />
      </ListButton>
      <ToolbarSeparator />
      {/* blocks: quote / divider / code / table */}
      <BlockButton pluginKey="blockquote" title="Blockquote">
        <Quote />
      </BlockButton>
      <DividerButton />
      <CodeBlockButton />
      <TableMenu />
      <ToolbarSeparator />
      {/* link */}
      <LinkButton />
      <ToolbarSeparator />
      {/* history + clear */}
      <HistoryButton kind="undo" />
      <HistoryButton kind="redo" />
      <ClearFormattingButton />
    </div>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  readOnly,
}: {
  /** Initial markdown. Seeded once into the editor on mount / when the id changes. */
  value: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}) {
  const editor = usePlateEditor({
    plugins: [
      BoldPlugin,
      ItalicPlugin,
      UnderlinePlugin,
      StrikethroughPlugin,
      CodePlugin.withComponent(CodeLeaf),
      H1Plugin.withComponent(H1Element),
      H2Plugin.withComponent(H2Element),
      H3Plugin.withComponent(H3Element),
      BlockquotePlugin.withComponent(BlockquoteElement),
      HorizontalRulePlugin.withComponent(HrElement),
      // Indent is the substrate the v53 list model rides on (list = indent + listStyleType).
      IndentPlugin,
      // Override belowNodes so task lists render an interactive checkbox (ListContainer).
      ListPlugin.configure({ render: { belowNodes: ListContainer } }),
      LinkPlugin.withComponent(LinkElement),
      // GFM tables.
      TablePlugin.withComponent(TableElement),
      TableRowPlugin.withComponent(TableRowElement),
      TableCellPlugin.withComponent(TableCellElement),
      TableCellHeaderPlugin.withComponent(TableCellHeaderElement),
      // Fenced code blocks (lowlight syntax highlighting).
      CodeBlockPlugin.configure({
        node: { component: CodeBlockElement },
        options: { lowlight },
      }),
      CodeLinePlugin.withComponent(CodeLineElement),
      CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
      MarkdownPlugin.configure({
        options: { remarkPlugins: [remarkGfm] },
      }),
    ],
  });

  // Seed the editor from the incoming markdown ONCE (and again only if the caller swaps to
  // a different document, tracked by the value's identity at mount of a given guide). We
  // deliberately don't re-seed on every keystroke — the editor owns the live state.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (value && value.trim()) {
      editor.tf.setValue(editor.api.markdown.deserialize(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/40 focus-within:border-border-strong",
        className,
      )}
    >
      <Plate
        editor={editor}
        onChange={() => {
          if (readOnly) return;
          onChange?.(editor.api.markdown.serialize());
        }}
      >
        <EditorToolbar />
        <PlateContent
          readOnly={readOnly}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            "min-h-64 px-4 py-3 text-[13.5px] leading-relaxed text-foreground/90 outline-none",
            "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
            "[&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary [&_a]:underline",
          )}
        />
      </Plate>
    </div>
  );
}
