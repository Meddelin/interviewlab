# v3.0 — прожарка v2 и план overhaul

Дата: 2026-07-01. Основано на аудите кода (frontend/backend/docs) в этом воркдереве.

## Прожарка

### Продакт
1. **Ценность заперта в приложении.** Synthesis/diff/summary нельзя отдать стейкхолдеру: нет отчёта-деливерабла. Исследователь работает ради отчёта — его нет.
2. **Агент пассивен.** Chat отвечает, но ничего не делает: tool-use (Phase B) — пустая таблица `chat_tool_call`. «AI-ассистент», который не может добавить термин в глоссарий, — это FAQ, а не ассистент.
3. **Каждая волна начинается с нуля.** REDUCE не видит прошлую волну — «кумулятивный синтез» остался в роадмапе.
4. **Нет сценария "подготовка"**: приложение живёт только после интервью. Гайд пишется руками, покрытие гайда интервью никто не проверяет — а это главный страх исследователя («мы всё спросили?»).
5. **Данные теряются в один клик**: удаление интервью и Re-transcribe без подтверждения (P0 из v2-audit, не закрыт).

### Дизайнер
1. **Широкий монитор наполовину пустой**: контент прижат влево (App.tsx:233, cycle-detail:136), findings в одну колонку.
2. **Wayfinding сломан**: внутри цикла не видно имени цикла, табы не в URL, deep-link невозможен.
3. **Cmd+K — витрина, а не инструмент**: 4 действия, нет навигации по интервью/табам.
4. **Прогресс живёт в локальном стейте**: ушёл со страницы — потерял индикацию ASR/синтеза. Нужен глобальный task-центр.
5. **Кнопка с матом в транскрипт-редакторе** (transcript-editor.tsx:551,564) — профессионально недопустимо, ещё и в aria-label.
6. Микронесогласованность: p-3/p-4/p-6 вперемешку, text-xs/text-sm на одном уровне, тяжёлые тени диалогов против плоского Linear-стиля.

### Инженер
1. **Chat-поток без таймаута** (chat.rs:649) — зависший CLI вечно держит поток; child-процессы без `kill_on_drop` → сироты.
2. **Глоссарий инжектится неравномерно**: есть в cleanup, нет в synthesis/diff/chat — термины «плывут» на самых дорогих стадиях.
3. **Правки markdown не синхронизированы с findings_json** — diff и chat видят устаревшие данные, юзер об этом не знает.
4. God-компоненты: transcript-editor 1872 LOC, settings 1779, interviews-tab 1024.
5. Segment id = индекс массива (нестабильные цитаты). **Отложено из v3**: миграция затрагивает весь пайплайн, без e2e-прогона на живом железе риск выше пользы. Кандидат на v3.1.

## План v3 (рабочие пакеты)

### Волна 1 — backend + shell (параллельно)
- **B1 — новые агентские сценарии** (владеет: новый `coverage.rs`, `guides.rs`, `adapter.rs`, `lib.rs`, `migrations/0010*`, frontend seams `tauri.ts`/`dev-mock.ts`):
  - `run_guide_coverage(interview_id)` — покрытие целей/вопросов гайда интервью: covered/partial/missed + evidence + предложенные follow-up вопросы. Таблица `coverage`.
  - `generate_guide_draft(product_id, research_questions)` — черновик гайда из продукта (цели, гипотезы, вопросы) → новая запись guide.
  - Task-дескрипторы в bundled-манифест; `kill_on_drop(true)` для child-процессов.
- **B2 — chat-агент 2.0** (владеет: `chat.rs`; lib.rs/tauri.ts НЕ трогает — выдаёт список регистраций в отчёте):
  - Idle-timeout watchdog на стрим.
  - Глоссарий в контекст чата.
  - **Action-blocks tool-use** (CLI-агностично, без MCP): ассистент эмитит fenced-блок ` ```invlab-action {json} ``` `; backend вырезает из текста, валидирует по whitelist (`glossary.add_terms`, `synthesis.update_finding`), исполняет, пишет в `chat_tool_call` (+undo_token), эмитит `chat://<thread>` событие типа `action`. Команда `undo_chat_action(tool_call_id)`.
- **B3 — синтез 2.0** (владеет: `synthesis.rs`, `diff.rs`):
  - Глоссарий (`render_for_prompt`) в extract/reduce/diff.
  - Кумулятивный синтез: exec-summary прошлой волны + diff в REDUCE-промпт.
  - Предупреждение о расхождении content_md и findings_json (флаг в get_synthesis).
- **F1 — shell overhaul** (владеет: `App.tsx`, `command-palette.tsx`, новые `lib/task-store.ts`, `components/task-center.tsx`, `pages/cycles.tsx`, `index.css`):
  - Глобальный task-центр: слушает `asr://progress`, `interview://progress`, `synthesis://progress`, `cleanup://progress`, бейдж в хедере + поповер со списком задач; прогресс переживает навигацию.
  - Breadcrumbs с именем цикла в хедере.
  - Cmd+K: навигация по интервью активного цикла, табам, действиям (transcribe, synthesize, export, coverage), чит-шит.
  - Центровка контента на широких мониторах (App-уровень).
  - Cycles-лист: статус-сводка (интервью/synthesized/diff), полировка.

### Волна 2 — frontend features + hygiene (после волны 1)
- **F2 — новые фичи UI** (владеет: `guides.tsx`, `interview-summary-panel.tsx`, новый `lib/report-export.ts`, `synthesis-tab.tsx`, `diff-tab.tsx`):
  - Guide-gen: кнопка «Сгенерировать из продукта» + диалог.
  - Coverage-панель в правой панели редактора интервью (в interview-summary-panel).
  - **HTML-отчёт волны**: standalone HTML (синтез + diff + цитаты + coverage), инлайн-стили в духе design-direction, сохранение через Tauri dialog. Кнопки в synthesis-tab; экспорт diff.
  - Retry для упавшего синтеза; бейдж «markdown разошёлся с findings».
- **F3 — chat UI + hygiene** (владеет: `cycle-chat-panel.tsx`, `interviews-tab.tsx`, `transcript-editor.tsx`, `cycle-detail.tsx`):
  - Чипы действий агента в чате (+undo), retry упавшего ответа.
  - Confirm-диалоги: удаление интервью, re-transcribe/re-clean/re-diarize (с текстом «сотрёт правки»).
  - Переименовать матерную кнопку → «Переписать сегмент»/“Rewrite segment” (и aria-label).
  - Unsaved-guard (router blocker) в редакторе и overview; табы cycle-detail в URL (?tab=); центровка контента cycle-detail; поиск по транскрипту (Ctrl+F перехват).

### Правила для всех пакетов
- i18n: co-located `STR = {ru, en}` + `useT`; ru — основной.
- Дизайн: docs/design-direction.md (dark-first, hairline, один индиго-акцент, tabular numerals, плоско, 6–8px radius).
- Валидация: `npx tsc --noEmit` (frontend), `cargo check` (backend). Приложение не запускать.
- Версия: 3.0.0 (bump в конце, оркестратором).
