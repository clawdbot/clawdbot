export function isSlackMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const mentionMatch = text.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch && /^[A-Z0-9]{8,}$/i.test(mentionMatch[1] ?? "")) {
    return false;
  }

  const withoutPrefix = text.replace(/^(slack|user):/i, "").trim();
  if (/^[UWBCGDT][A-Z0-9]{2,}$/.test(withoutPrefix)) {
    return false;
  }
  if (/^[A-Z0-9]{8,}$/i.test(withoutPrefix)) {
    return false;
  }

  return true;
}
