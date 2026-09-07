// Imessage plugin shared helper: strip leading attributedBody corruption markers from echo text.
// The in-memory (echo-cache) and persisted (persisted-echo-cache) echo-dedupe paths must normalize
// identically, so a reflected own-message echo whose attributedBody decoded with a leading
// NUL/replacement marker still matches the clean stored send. Kept here (a leaf module with no
// imports) so the persisted path can reuse it without an echo-cache <-> persisted-echo-cache cycle.

function isLeadingEchoTextCorruptionMarker(code: number): boolean {
  return (
    code === 0x0000 || code === 0xfeff || code === 0xfffd || code === 0xfffe || code === 0xffff
  );
}

export function stripLeadingEchoTextCorruptionMarkers(text: string): string {
  let offset = 0;
  while (offset < text.length && isLeadingEchoTextCorruptionMarker(text.charCodeAt(offset))) {
    offset += 1;
  }
  return offset === 0 ? text : text.slice(offset);
}
