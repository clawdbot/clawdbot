const methods = new Set(
  JSON.parse(process.env.TELEGRAM_E2E_IGNORE_ABORT_METHODS || "[]").map((method) =>
    method.toLowerCase(),
  ),
);

if (methods.size > 0) {
  const originalAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function ignoreHeldTelegramTimeout(reason) {
    const match =
      reason instanceof Error ? /^Telegram ([a-z]+) timed out /u.exec(reason.message) : null;
    if (match && methods.has(match[1])) return;
    originalAbort.call(this, reason);
  };
}
