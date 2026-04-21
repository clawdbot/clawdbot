export function finalizeTelegramInboundContextForTest(ctx: unknown): Record<string, unknown> {
  const next = ctx as Record<string, unknown>;
  const body = typeof next.Body === "string" ? next.Body : "";
  next.Body = body;
  next.BodyForAgent =
    typeof next.BodyForAgent === "string"
      ? next.BodyForAgent
      : typeof next.RawBody === "string"
        ? next.RawBody
        : body;
  next.BodyForCommands =
    typeof next.BodyForCommands === "string"
      ? next.BodyForCommands
      : typeof next.CommandBody === "string"
        ? next.CommandBody
        : typeof next.RawBody === "string"
          ? next.RawBody
          : body;
  next.CommandAuthorized = Boolean(next.CommandAuthorized);
  return next;
}
