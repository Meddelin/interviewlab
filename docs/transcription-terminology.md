# Russian transcripts with anglicisms — cleanup terminology approach

Real interviews here are **Russian product/tech talk**, dense with English terms and anglicisms
("churn", "retention", "product-market fit", "API", "Figma", "AI-native"). Whisper large-v3
transcribes Russian well but **mangles English terms** — it renders them phonetically in Cyrillic,
inconsistently, or mishears them ("эй-пи-ай", "продакт-маркет фит", "джира"). The cleanup pass is
where we fix that. Before, the cleanup prompt was generic ("fix grammar, keep terminology") with **no
terminology handling at all**.

## What the research says (June 2026)
- **Post-ASR LLM error correction** ("understanding-then-rewriting", single pass) is the standard
  fix for grammar + terminology. Preserve high-confidence spans, rewrite uncertain ones, and **never
  hallucinate** named entities or numbers. ([Amazon Science generative AEC](https://assets.amazon.science/77/26/6c265e0a42d7a40d2ee8bdd158e6/generative-speech-recognition-error-correction-with-large-language-models-and-task-activating-prompting.pdf))
- **Named entities / rare technical terms are the hardest** to recover generatively — the model
  can't reliably introduce a term that isn't already in the hypothesis. The fix is a **glossary /
  entity phrase-list** injected as context, with edits constrained toward those entities.
  ([DeRAGEC](https://arxiv.org/pdf/2506.07510), [Apple retrieval-ASR](https://machinelearning.apple.com/research/retrieval-asr), [code-aware ASR refinement](https://www.emergentmind.com/topics/code-aware-asr-output-refinement))
- **Context injection helps the ASR itself** — feeding expected terms into the prompt improves
  recognition of specialized vocabulary upfront (cheaper than fixing it after). ([Whisper context generation, arXiv 2602.18966](https://arxiv.org/pdf/2602.18966))
- **Glossaries must be focused, not dumped** — inject brand/technical/frequently-mistranscribed
  terms only; over-stuffing is counterproductive. ([WMT'25 terminology task](https://arxiv.org/pdf/2510.17504), [AlphaCRC](https://alphacrc.com/blog-post/tailoring-your-translation-terminology-how-to-give-your-llm-a-head-start-in-localization/))
- **Russian-specific:** English borrowings legitimately appear in **both** Latin and Cyrillic — even
  in one sentence ("свежие notebook'и – ноутбуки"). There is **no single correct script**; assimilated
  slang gets Cyrillicized (listing→листинг), brands/acronyms stay Latin. So the goal is **consistency
  + following the domain convention**, not blanket Latinizing or Cyrillicizing.
  ([English loanwords in Russian](https://www.researchgate.net/publication/250009605_The_Integration_of_English_Loanwords_in_Russian_An_Overview_of_Recent_Borrowings))

## What's implemented now (`cleanup.rs` → `guidelines_for`)
The cleanup guidelines now carry explicit terminology rules:
- Fix phonetically-garbled / mis-heard English terms when the intended term is clear ("эй-пи-ай" → API,
  "джира" → Jira) — but **don't invent** terms/names/numbers not in the audio.
- Acronyms/initialisms → UPPERCASE Latin (API, MVP, SaaS, B2B, KPI, UX, AI, LLM, SDK…).
- Product/brand/tool names → canonical spelling (Figma, Jira, GitHub, Notion).
- Fully-assimilated slang → standard Cyrillic, do NOT Latinize (дедлайн, фича, баг, релиз, кейс, юзер…).
- **Never translate** a term the speaker chose (don't swap "churn" ↔ "отток").
- **Be consistent** — one spelling per term.
- The **product context** is framed as the **glossary** — its spelling of any product/brand/domain term
  is the authority.

## Recommended next step — a dedicated, curated glossary (highest leverage)
The product `content_md` is prose; the research's strongest lever is a **focused term list**. Add a
per-product (and/or per-cycle) **Glossary**: `term → canonical spelling` (+ optional aliases/notes),
and inject it into:
1. **Whisper `initial_prompt`** — bias the ASR so it gets the terms right upfront (entity recovery is
   far better before the fact than after).
2. **Every cleanup batch** — the entity phrase-list anchors named-entity spellings AND fixes the
   cross-batch consistency gap (batches are independent `claude` calls today, so only the glossary +
   the deterministic rules guarantee the same term is spelled the same way across the whole transcript).
3. Optionally synthesis/chat — consistent term usage in findings.

This is a moderate feature (a field on product/cycle + a small editor + wiring into 2-3 prompts).
Not built yet — implement on request.
