const REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES = 8_000;

export function boundTalkClientRealtimeInitialItems(
  items: readonly { role: "user" | "assistant"; text: string }[],
): Array<{ role: "user" | "assistant"; text: string }> {
  // Keep startup context below provider byte ceilings while retaining the newest
  // complete turns; truncating an individual entry would change transcript meaning.
  let remainingBytes = REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES;
  const newestFirst: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const itemBytes = Buffer.byteLength(item.text, "utf8");
    if (itemBytes > remainingBytes) {
      break;
    }
    newestFirst.push(item);
    remainingBytes -= itemBytes;
  }
  return newestFirst.toReversed();
}
