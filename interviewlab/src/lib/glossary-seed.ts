import type { NewGlossaryTerm } from "@/lib/tauri";

// Curated starter glossary for Russian-language product / user-research interviews.
//
// Why this exists: Russian tech speech is full of anglicisms, transliterations, and brand names
// that whisper.cpp mis-hears (and spells inconsistently). `canonical` is the spelling we want in
// the transcript; `aliases` are the garbled / variant / Latin forms the ASR tends to produce.
// These feed BOTH whisper's initial_prompt (biasing recognition — so ORDER matters, the prompt
// buffer is small and only the lead survives the cap) AND the cleanup post-correction pass.
//
// Convention:
//   - Russian-ized common anglicisms → canonical is the accepted Cyrillic spelling (фича, дедлайн).
//   - Acronyms → canonical is the uppercase Latin form (API, MVP, NPS), aliases the spoken Cyrillic.
//   - Brand / tool names → canonical is the original Latin name (Figma, Jira), aliases the Cyrillic.
//
// Ordered by priority (most common & most-confused first) so the highest-value terms lead the
// ASR prompt. The full list still helps via cleanup even past the prompt cap.
export const GLOSSARY_SEED: NewGlossaryTerm[] = [
  // --- product / research core (lead the prompt) ---
  { canonical: "фича", aliases: ["feature", "фитча", "фиче", "фичи"], notes: "функция продукта" },
  { canonical: "релиз", aliases: ["release", "релис", "релизы"], notes: "выпуск версии" },
  { canonical: "бэклог", aliases: ["backlog", "беклог", "бэк-лог"], notes: "список задач" },
  { canonical: "спринт", aliases: ["sprint", "спринты"], notes: "итерация разработки" },
  { canonical: "дедлайн", aliases: ["deadline", "дэдлайн"], notes: "срок" },
  { canonical: "онбординг", aliases: ["onboarding", "онбоардинг", "онбординк"], notes: "адаптация пользователя" },
  { canonical: "отток", aliases: ["churn", "чёрн", "чорн", "чурн"], notes: "отток клиентов (churn)" },
  { canonical: "ретеншн", aliases: ["retention", "ретеншен", "ретенш", "удержание"], notes: "удержание пользователей" },
  { canonical: "конверсия", aliases: ["conversion", "конверсии"], notes: "доля целевых действий" },
  { canonical: "воронка", aliases: ["funnel", "воронка продаж"], notes: "последовательность шагов" },
  { canonical: "метрика", aliases: ["metric", "метрики"], notes: "показатель" },
  { canonical: "гипотеза", aliases: ["hypothesis", "гипотезы"], notes: "проверяемое предположение" },
  { canonical: "инсайт", aliases: ["insight", "инсайты", "инсайд"], notes: "вывод из исследования" },
  { canonical: "боль", aliases: ["pain", "пейн", "пэйн"], notes: "боль / проблема пользователя" },
  { canonical: "кастдев", aliases: ["customer development", "кастомер девелопмент", "кастдэв", "custdev"], notes: "глубинные интервью" },
  { canonical: "JTBD", aliases: ["jobs to be done", "джоба", "джобстубидан", "job to be done"], notes: "«работа», ради которой берут продукт" },
  { canonical: "юзер", aliases: ["user", "юзеры", "юзера"], notes: "пользователь" },
  { canonical: "юзабилити", aliases: ["usability", "юзабельность"], notes: "удобство использования" },
  { canonical: "респондент", aliases: ["respondent", "респонденты"], notes: "участник интервью" },
  { canonical: "сегмент", aliases: ["segment", "сегменты"], notes: "группа пользователей" },
  { canonical: "персона", aliases: ["persona", "персоны"], notes: "обобщённый портрет пользователя" },
  { canonical: "кейс", aliases: ["case", "кейсы"], notes: "пример / сценарий" },
  { canonical: "MVP", aliases: ["эм-ви-пи", "мвп", "минимальный продукт"], notes: "минимально жизнеспособный продукт" },
  { canonical: "пивот", aliases: ["pivot", "пивотнуть"], notes: "смена стратегии" },
  { canonical: "роадмап", aliases: ["roadmap", "дорожная карта", "роудмап", "роадмэп"], notes: "план развития" },
  { canonical: "продакт", aliases: ["product manager", "продакт-менеджер", "пиэм", "PM", "продакт-овнер"], notes: "менеджер продукта" },
  { canonical: "стейкхолдер", aliases: ["stakeholder", "стейкхолдеры"], notes: "заинтересованная сторона" },
  { canonical: "фидбэк", aliases: ["feedback", "фидбек", "обратная связь"], notes: "обратная связь" },
  { canonical: "скоуп", aliases: ["scope", "скоп"], notes: "объём работ" },
  { canonical: "вовлечённость", aliases: ["engagement", "энгейджмент", "вовлеченность"], notes: "вовлечённость пользователей" },

  // --- dev / tech ---
  { canonical: "API", aliases: ["апи", "апишка", "эй-пи-ай"], notes: "программный интерфейс" },
  { canonical: "бэкенд", aliases: ["backend", "бекенд", "бэк"], notes: "серверная часть" },
  { canonical: "фронтенд", aliases: ["frontend", "фронт", "фронтэнд"], notes: "клиентская часть" },
  { canonical: "дашборд", aliases: ["dashboard", "дэшборд", "дашбоард"], notes: "панель показателей" },
  { canonical: "деплой", aliases: ["deploy", "деплоить", "деплои"], notes: "развёртывание" },
  { canonical: "продакшен", aliases: ["production", "прод", "продакшн"], notes: "боевая среда" },
  { canonical: "стейджинг", aliases: ["staging", "стейдж"], notes: "тестовая среда" },
  { canonical: "легаси", aliases: ["legacy", "легэси"], notes: "устаревший код" },
  { canonical: "рефакторинг", aliases: ["refactoring", "рефактор"], notes: "переработка кода" },
  { canonical: "репозиторий", aliases: ["repository", "репа", "репо"], notes: "хранилище кода" },
  { canonical: "коммит", aliases: ["commit", "коммитить", "коммиты"], notes: "фиксация изменений" },
  { canonical: "мёрдж", aliases: ["merge", "мёрж", "мердж", "мерж"], notes: "слияние веток" },
  { canonical: "пул-реквест", aliases: ["pull request", "PR", "пиар", "пулреквест"], notes: "запрос на слияние" },
  { canonical: "CI/CD", aliases: ["си-ай-си-ди", "сиайсиди"], notes: "непрерывная интеграция/доставка" },
  { canonical: "Docker", aliases: ["докер"], notes: "контейнеризация" },
  { canonical: "Kubernetes", aliases: ["кубернетес", "кубер", "k8s", "кубернетис"], notes: "оркестрация контейнеров" },
  { canonical: "микросервис", aliases: ["microservice", "микросервисы"], notes: "архитектурный стиль" },
  { canonical: "монолит", aliases: ["monolith", "монолитный"], notes: "единое приложение" },
  { canonical: "латенси", aliases: ["latency", "лэтенси", "задержка"], notes: "задержка отклика" },
  { canonical: "вебхук", aliases: ["webhook", "вебхуки"], notes: "обратный вызов по событию" },
  { canonical: "эндпоинт", aliases: ["endpoint", "эндпоинты"], notes: "точка API" },
  { canonical: "токен", aliases: ["token", "токены"], notes: "ключ доступа" },
  { canonical: "кэш", aliases: ["cache", "кеш", "кэширование"], notes: "промежуточное хранилище" },
  { canonical: "фича-флаг", aliases: ["feature flag", "фичефлаг", "фиче-флаг"], notes: "флаг включения функции" },
  { canonical: "SDK", aliases: ["эс-ди-кей"], notes: "набор разработчика" },
  { canonical: "SaaS", aliases: ["сас", "эс-эй-эс", "саас"], notes: "ПО как сервис" },
  { canonical: "баг", aliases: ["bug", "баги"], notes: "ошибка" },
  { canonical: "хотфикс", aliases: ["hotfix", "хотфиксы"], notes: "срочное исправление" },
  { canonical: "таска", aliases: ["task", "таски"], notes: "задача" },
  { canonical: "стори", aliases: ["story", "юзерстори", "user story", "сторя"], notes: "пользовательская история" },
  { canonical: "эпик", aliases: ["epic", "эпики"], notes: "крупная задача" },

  // --- research methods / metrics ---
  { canonical: "юзкейс", aliases: ["use case", "юз-кейс", "юзкейсы"], notes: "сценарий использования" },
  { canonical: "юзер-флоу", aliases: ["user flow", "юзерфлоу"], notes: "пользовательский поток" },
  { canonical: "CJM", aliases: ["customer journey", "кастомер джорни", "си-джей-эм", "путь пользователя"], notes: "карта пути пользователя" },
  { canonical: "тачпоинт", aliases: ["touchpoint", "тачпоинты"], notes: "точка контакта" },
  { canonical: "прототип", aliases: ["prototype", "прото", "прототипы"], notes: "макет" },
  { canonical: "вайрфрейм", aliases: ["wireframe", "варфрейм", "вайрфреймы"], notes: "каркас интерфейса" },
  { canonical: "A/B-тест", aliases: ["аб-тест", "эй-би тест", "ab test", "a/b тест"], notes: "сплит-тест" },
  { canonical: "NPS", aliases: ["эн-пи-эс"], notes: "индекс потребительской лояльности" },
  { canonical: "CSAT", aliases: ["си-сат", "цсат"], notes: "удовлетворённость" },
  { canonical: "KPI", aliases: ["кей-пи-ай", "кипиай"], notes: "ключевой показатель" },
  { canonical: "OKR", aliases: ["окей-ар", "окр", "оу-кей-ар"], notes: "цели и ключевые результаты" },
  { canonical: "DAU", aliases: ["дау"], notes: "активные пользователи за день" },
  { canonical: "MAU", aliases: ["мау"], notes: "активные пользователи за месяц" },
  { canonical: "LTV", aliases: ["эл-ти-ви"], notes: "пожизненная ценность клиента" },
  { canonical: "CAC", aliases: ["цак", "как", "си-эй-си"], notes: "стоимость привлечения" },
  { canonical: "ARPU", aliases: ["арпу"], notes: "средний доход на пользователя" },
  { canonical: "стендап", aliases: ["standup", "стэндап", "дейли"], notes: "ежедневная встреча команды" },
  { canonical: "ретро", aliases: ["retrospective", "ретроспектива"], notes: "ретроспектива спринта" },
  { canonical: "груминг", aliases: ["grooming", "рефайнмент", "refinement"], notes: "разбор бэклога" },
  { canonical: "эстимейт", aliases: ["estimate", "эстимейты", "оценка"], notes: "оценка трудоёмкости" },
  { canonical: "велосити", aliases: ["velocity"], notes: "скорость команды" },
  { canonical: "интервью", aliases: ["interview"], notes: "исследовательское интервью" },
  { canonical: "рекрутинг", aliases: ["recruiting", "рекрут", "рекрут респондентов"], notes: "подбор участников" },
  { canonical: "вербатим", aliases: ["verbatim"], notes: "дословная цитата" },

  // --- tools / brands commonly named in interviews ---
  { canonical: "Figma", aliases: ["фигма", "фигме"], notes: "инструмент дизайна" },
  { canonical: "Jira", aliases: ["джира", "жира"], notes: "трекер задач" },
  { canonical: "Slack", aliases: ["слак", "слэк"], notes: "корпоративный мессенджер" },
  { canonical: "Notion", aliases: ["ноушн", "нотион", "ношн"], notes: "база знаний / заметки" },
  { canonical: "Zoom", aliases: ["зум"], notes: "видеозвонки" },
  { canonical: "Miro", aliases: ["миро"], notes: "онлайн-доска" },
  { canonical: "Amplitude", aliases: ["амплитьюд", "амплитуда"], notes: "продуктовая аналитика" },
  { canonical: "Mixpanel", aliases: ["микспанель", "микспанел"], notes: "продуктовая аналитика" },
  { canonical: "Google Analytics", aliases: ["гугл аналитикс", "GA", "джи-эй"], notes: "веб-аналитика" },
  { canonical: "Confluence", aliases: ["конфлюенс"], notes: "база знаний" },
  { canonical: "Trello", aliases: ["трелло"], notes: "канбан-доска" },
  { canonical: "GitHub", aliases: ["гитхаб", "гит хаб"], notes: "хостинг кода" },
  { canonical: "GitLab", aliases: ["гитлаб"], notes: "хостинг кода / CI" },
  { canonical: "Telegram", aliases: ["телеграм", "тг"], notes: "мессенджер" },
];
