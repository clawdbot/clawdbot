const CONTROL_COMMAND_RE =
  /(?:^|\s)\/(?:status|help|thinking|think|t|verbose|v|elevated|elev|model|queue|activation|send|restart|reset|new|compact)(?=$|\s|:)\b/i;

const CONTROL_COMMAND_EXACT = new Set([
  "/help",
  "/status",
  "/restart",
  "/activation",
  "/send",
  "/reset",
  "/new",
  "/compact",
]);

export function hasControlCommand(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();
  if (CONTROL_COMMAND_EXACT.has(lowered)) return true;
  return CONTROL_COMMAND_RE.test(text);
}
