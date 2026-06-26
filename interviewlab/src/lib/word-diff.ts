// Word-level inline diff (GitHub/GitLab "inline" style) for transcript segments.
//
// Transcript edits are small — a fixed word here, a re-clean of one sentence there — so a
// word-granular diff reads far better than a character or line diff: it highlights exactly
// the words that changed while leaving the untouched run as plain text. The editor uses this
// to show "what changed vs the original" per segment.

export type DiffPartType = "eq" | "del" | "ins";
export type DiffPart = { type: DiffPartType; value: string };

// Split into alternating word / whitespace tokens, KEEPING the whitespace as its own tokens.
// Diffing over these (instead of words alone) means re-joining the parts reproduces the text
// verbatim — spacing and punctuation-attached-to-words survive a round trip.
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

// A classic LCS over tokens → a minimal sequence of equal / deleted / inserted runs.
// Segments are short (a sentence to a paragraph), so the O(n·m) table is cheap. Adjacent
// parts of the same type are coalesced so the rendered diff is a few spans, not dozens.
export function wordDiff(oldText: string, newText: string): DiffPart[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPartType, value: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.value += value;
    else parts.push({ type, value });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return parts;
}

// True when the two texts differ once leading/trailing whitespace is ignored (the editor
// trims segment text for comparison, so a stray edge space never reads as a change).
export function textChanged(oldText: string, newText: string): boolean {
  return oldText.trim() !== newText.trim();
}
