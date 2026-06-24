# Reuse Landscape — что переиспользовать, а что строить

Цель: не делать лишнего. Берём только то, что зрело, активно поддерживается и имеет **разрешительную лицензию** (MIT/Apache/BSD/MPL) — это распространяемое десктоп-приложение, поэтому GPL/AGPL/LGPL и source-available лицензии под запретом на *вендоринг кода* (можно только смотреть как на референс).

Детальные обзоры по кластерам:
- [Редакторы, транскрипт-UI, waveform](reuse/editors-and-transcript-ui.md)
- [Agent-loop и оркестрация локального CLI](reuse/agent-cli-orchestration.md)
- [Локальная транскрипция + Tauri-скелеты + упаковка](reuse/transcription-and-tauri.md)
- [Доменные OSS (qual-research) + shadcn-блоки](reuse/domain-and-shadcn-blocks.md)

## TL;DR — таблица решений

| Потребность | Решение | Что берём | Лицензия |
|---|---|---|---|
| Редактор синтеза/markdown (красивый) | **REUSE** | **Plate** (ставится через shadcn-реестр, компоненты в нашем коде) + **CodeMirror 6** для raw-режима | MIT |
| Редактор транскрипта (сегменты + правка + роли) | **BUILD** | наш дифференциатор; логику взять у **hyperaudio-lite**, модель данных — у **BBC react-transcript-editor** | MIT (референсы) |
| Аудио-плеер с waveform и тайм-синком | **REUSE** | **wavesurfer.js** + `@wavesurfer/react` (+ Regions/Timeline) | BSD-3 |
| Запуск Claude Code | **REUSE-паттерн** | shell-out `claude -p` из Rust через `tauri-plugin-shell` (стрим stdout, cancel через `child.kill()`) | — |
| Схема CLI-адаптера | **COMPOSE** | MCP-стиль `command`/`args`/`env` + `{prompt}` + `jq outputPath` | — |
| ASR-движок (биндинг) | **РЕШИТЬ** ↓ | **whisper.cpp через `whisper-rs`** (путь Vibe) *или* `ct2rs` (оставить faster-whisper) — без бандла Python | MIT / Unlicense |
| Референс whisper-приложения | **MINE** | **Vibe** — копируем UX скачивания моделей, GPU-детект, ffmpeg, упаковку сайдкара | MIT |
| Стартовый скелет | **REUSE** | **agmmnn/tauri-ui** (Tauri 2 + shadcn через офиц. CLI) | MIT |
| GPU-детект / ffmpeg | **REUSE** | `nvml-wrapper`, `ffmpeg-sidecar` | MIT/Apache |
| shadcn-блоки (DataTable, kanban, dropzone) | **REUSE** | **shadcn official** + **DiceUI** + **Kibo UI** | MIT |
| View диффа | **REUSE** | `@git-diff-view/react` | MIT |
| Доменный UX (кодинг/теги/синтез) | **REFERENCE** | **Taguette**, **QualCoder** | BSD-3 / LGPL (только смотреть) |

## По областям (коротко)

### UI: редакторы и транскрипт
- **Синтез/markdown → Plate.** Сам себя описывает как «rich-text editor с shadcn/ui», ставится через shadcn CLI — идеально под правило «UI только из shadcn». Запасной: `shadcn-editor` (Lexical+shadcn) или MDXEditor.
- **Транскрипт-редактор → строим сами.** В 2026 нет живого, современного, React, разрешительного дропина. Это и есть наша ценность (сегменты + inline-правка + ручные роли + аудио-синк). Логику берём у hyperaudio-lite (MIT, активен), модель данных — у BBC (MIT, но заморожен с 2021).
- **Waveform → wavesurfer.js + `@wavesurfer/react`** (BSD-3, активный). peaks.js — только если многочасовые файлы начнут тормозить (и он LGPL → не вендорить).

### Agent / локальный CLI
- **Вывод: shell-out к `claude -p` из Rust — самый простой и единственный ToS-совместимый путь под подписку.** Важная внешняя вводная: примерно с **апреля 2026 Anthropic блокирует сторонние «харнессы» от использования Pro/Max-подписки** в headless. Поэтому **никакой агент-фреймворк нельзя легально использовать как зависимость для драйва подписочного Claude** — годится только официальный бинарь `claude` (и Agent SDK через локальную сессию). Это ровно наш дизайн → менять нечего, наоборот подтверждает выбор «подписка + официальный CLI».
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — мощнее, но Node-only и тянет Node-сайдкар. Встраивать только если перерастём shell-out (нужны in-process tool-callbacks / resume сессий).
- **Референсы дизайна:** Goose (Apache, Rust, ближайший аналог shell-out), Cline SDK, OpenCode.
- **Адаптер-схема:** готового прелесть-стандарта нет — компонуем из MCP-скелета + `{prompt}` + jq-путь. Готовый дескриптор — в детальном обзоре.

### Транскрипция и упаковка
- **Ключевой вывод: брать Rust-биндинг, а не замороженный Python через PyInstaller** (минус целый Python-рантайм в бандле — большой ленивый выигрыш).
- **Vibe** (MIT, Tauri + whisper.cpp, Win/Nvidia) — донор кода для скачивания моделей, GPU-детекта, ffmpeg и упаковки сайдкара. **Whisper4Windows** — рецепт бандла cuBLAS/cuDNN DLL из pip-wheels в MSI (юзеру не нужен CUDA-тулкит).
- **ffmpeg:** берём **LGPL-сборку**, вызываем **отдельным процессом** (`ffmpeg-sidecar` это и делает), кладём атрибуцию LGPLv2.1 в About/EULA.

### shadcn-блоки и домен
- Строим на **shadcn official (MIT)**, три пробела (kanban, dropzone, timeline/diff) закрываем из **DiceUI** (один вендор: DataTable + kanban + file-upload) и **Kibo UI**. Прелесть-зависимости, что shadcn и так оборачивает: TanStack Table, cmdk, react-resizable-panels, react-dropzone, dnd-kit — все MIT.
- **Домен (qual-research) — всё только REFERENCE, кода не берём.** Taguette: 3-панельный code-and-retrieve + вкладка «Highlights» (группировка цитат под тегом = наш evidence-linking). QualCoder: иерархический кодбук + **прозрачные/редактируемые AI-промпты** + **проектное memo, инжектируемое в каждый промпт** (ложится на «синтез, привязанный к целям гайда»).

## License watchlist — НЕ вендорить код
- **BlockNote `xl-*`** = GPL-3.0 (ядро MPL ок, но легко выстрелить в ногу) → редактор берём Plate, не BlockNote.
- **peaks.js** = LGPL-3.0, **Subtitle Edit / Aegisub** = GPL → только референс.
- **Origin UI** — новые «Particles»-компоненты стали **AGPL-3.0** (поглощён в Cal.com coss); проверять header у каждого копируемого файла, проще брать Kibo/DiceUI.
- **Crush (Charm)** = FSL-1.1 (2 года non-compete) — читать можно, вендорить в конкурирующий продукт нельзя.
- **Open Interpreter (Python)** = AGPL, **tgpt/Zed** = GPL/AGPL → только дизайн-референс.
- CUDA/cuDNN DLL — распространяемы под условиями NVIDIA (рантайм-бандл ок), версии под текущий CTranslate2: CUDA 12 + cuDNN 9.

## Открытое решение для тебя: биндинг ASR-движка
Обзор рекомендует уйти от «faster-whisper как Python-сайдкар» (в спеке §6) ради отсутствия бандла Python. Два пути:

- **A. whisper.cpp через `whisper-rs` (путь Vibe) — рекомендую для MVP.** Самый зрелый биндинг, без Python, проверен ровно на Win+Nvidia+Tauri, и у Vibe можно скопировать почти всю упаковку. Минус: другой формат моделей (ggml), теряем батч-скорость CTranslate2. large-v3 и русский поддерживаются.
- **B. `ct2rs` (оставить CTranslate2/faster-whisper).** Сохраняет движок, точность и int8 CPU-fallback из спеки, но биндинг маленький (~57★) → выше интеграционный риск; нужен CUDA-тулкит на сборке.

> Рекомендация: **A** (whisper.cpp/whisper-rs) для MVP — меньше риска и максимум копируемого кода из Vibe; если по замерам упрёмся в скорость/точность, мигрируем на ct2rs. Это меняет §6 спеки (движок и формат моделей).
