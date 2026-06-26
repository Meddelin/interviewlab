# Feature: Import a diarized transcript (.txt)

> **Status:** implemented. Date: 2026-06-26.
> **Why now:** the founder often already has a ready, diarized transcript (e.g. exported from another
> tool) and wants to attach it directly instead of running local ASR — but still keep the audio so every
> editor feature (media seek, clear a segment, re-transcribe a range, re-diarize, clean, synthesis) works.
>
> **Reads / amends:** `product-spec.md` §2.2 (segment schema), §4.5 (timing-immutable invariant),
> `feature-diarization.md` (speaker labels). This adds an alternative path to producing the **raw**
> transcript: instead of `transcribe_interview` (whisper + sherpa), the user imports a `.txt`.

---

## 1. User flow

1. Add the audio/video file as usual (drag-drop or **Add files**) → it's ingested and normalized to the
   16 kHz mono WAV exactly as before.
2. On the interview's row, click **Import .txt** (next to **Transcribe**) and pick the transcript file.
3. The interview flips to **Transcribed**. Open the editor: segments carry the file's real timestamps,
   speakers come pre-bound as participants, and the waveform/seek/clear/re-transcribe/re-diarize/clean
   actions all work against the still-attached audio.

Re-importing a corrected file is supported and idempotent — it replaces the raw transcript and **preserves
any role binding** already assigned to a matching speaker name.

## 2. File format

Plain UTF-8 text (a leading BOM is tolerated). Reply blocks separated by a blank line; each block is:

```
<M:SS - M:SS>      timestamp line (start - end)
<Speaker name>     one name per line, repeats allowed
<reply text>       one or more lines, any characters
```

Example:

```
0:01 - 0:12
Stanislav Medvedev
Так смотри, мы сейчас в целом планируем наш замечательный бивер.

0:40 - 0:51
Andrey Belokopytov
Да, ну так-то, конечно, есть кое-что.
```

## 3. Parsing rules (`src-tauri/src/transcript.rs::parse_diarized_txt`)

- A **timestamp line** is recognized structurally: exactly three whitespace tokens, a dash separator
  (`-`, en-dash, or em-dash) in the middle, and both ends parsing as a time. Times are `M:SS`, `MM:SS`,
  or `H:MM:SS` (each colon field accumulates base-60). Requiring a colon means a bare "5 - 10" or a
  dash inside reply text ("да - нет") is never mistaken for a timestamp.
- After a timestamp, the **first non-empty line is the speaker**; every later non-empty line until the
  next timestamp is **reply text** (joined with a space). This tolerates multi-line replies and one-or-more
  blank lines between blocks; CRLF endings are handled.
- A reversed range collapses to a point (`end = start`) — timing never widens backwards (spec §4.5).
- Errors name the offending block (missing speaker / empty text / no blocks at all) so the file can be fixed.

## 4. What it writes

- A **raw** transcript (`kind='raw'`, `version=1`, `engine='import:txt'`, `language=NULL`) — replacing any
  existing raw, so re-import is idempotent. Segments use the same `{start_ms,end_ms,speaker_label,text}`
  shape as ASR output, so the editor, cleanup, and synthesis read it with no special-casing.
- **Participants**: one per distinct speaker name (first-seen order), `display_name` = `speaker_label` =
  the name, role left unassigned. A re-import keeps the role/identity of any participant whose
  `speaker_label` still matches.
- Interview **status → `transcribed`** (the same terminal state a whisper run produces).

The speaker names are kept verbatim as the per-segment `speaker_label` (no `S1`/`S2` remapping). Running
**Re-diarize** afterwards will overwrite them with ASR-clustered `S1/S2/…` labels if that's wanted.

## 5. Surface

- Backend command: `import_transcript_file(interview_id, path) -> { transcript_id, segments, speakers }`
  (`src-tauri/src/transcript.rs`, registered in `lib.rs`).
- Frontend: binding `importTranscriptFile` in `src/lib/tauri.ts`; the **Import .txt** row action +
  file picker in `src/components/interviews-tab.tsx`.
- Tests: parser + end-to-end import (raw + participants + status, and re-import role preservation) in the
  `transcript.rs` test module.
</content>
</invoke>
