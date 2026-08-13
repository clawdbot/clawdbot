// Voice Call plugin module splits long telephony replies for reliable synthesis.
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";

/**
 * Split a telephony reply into pieces no longer than `limit` characters,
 * preferring natural speech boundaries.
 *
 * A long reply synthesized as one request can exceed the provider synthesis
 * timeout and be dropped. Splitting keeps each piece within the budget so it
 * synthesizes and streams reliably; pieces are played back-to-back.
 *
 * Boundary priority:
 * 1. Sentence-ending punctuation (`. ! ?` and CJK `。！？`) — each piece begins
 *    and ends on a natural pause, so the small per-piece prosody reset lands
 *    where a speaker would already pause.
 * 2. Consecutive short sentences are packed together up to `limit` to minimize
 *    the number of synthesis requests (fewer boundaries = smoother speech).
 * 3. A single sentence longer than `limit` falls back to the shared
 *    hard-bounded splitter, which breaks on whitespace and hard-cuts an
 *    unbroken token (e.g. a long URL) so every returned piece is `<= limit`.
 *
 * Text at or under `limit` is returned unchanged as a single piece.
 */
export function chunkTelephonyReply(text: string, limit: number): string[] {
  const clean = (text ?? "").trim();
  if (!clean) {
    return [];
  }
  if (clean.length <= limit) {
    return [clean];
  }

  // Each match is one sentence including its terminal punctuation and trailing
  // whitespace; the final alternative captures a trailing run with no terminator.
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+\s*|[^.!?。！？]+$/g) ?? [clean];
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    buf = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // A single over-long sentence: emit what is buffered, then hard-bound it.
      flush();
      for (const piece of chunkTextForOutbound(sentence.trim(), limit)) {
        chunks.push(piece);
      }
    } else if ((buf + sentence).length > limit) {
      // Adding this sentence would overflow: close the current piece first.
      flush();
      buf = sentence;
    } else {
      buf += sentence;
    }
  }
  flush();

  return chunks.length ? chunks : [clean];
}
