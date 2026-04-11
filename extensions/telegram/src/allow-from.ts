export function normalizeTelegramAllowFromEntry(raw: unknown): string {
  const base = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return base
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function isNumericTelegramUserId(raw: string): boolean {
  return /^-?\d+$/.test(raw);
}

// Telegram sender authorization only accepts concrete user IDs. Negative chat IDs
// belong under `channels.telegram.groups`, not sender allowlists.
export function isNumericTelegramSenderUserId(raw: string): boolean {
  return /^\d+$/.test(raw);
}
