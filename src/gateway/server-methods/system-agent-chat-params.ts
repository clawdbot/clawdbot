const SYSTEM_AGENT_UI_CONTEXT_PAGE_PATTERN = /^[A-Za-z0-9/_-]{1,64}$/u;

export function sanitizeSystemAgentChatParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  const record = params as Record<string, unknown>;
  const context = record.context;
  if (context === undefined) {
    return params;
  }
  if (
    record.delegation !== undefined ||
    !context ||
    typeof context !== "object" ||
    Array.isArray(context)
  ) {
    const { context: _droppedContext, ...rest } = record;
    return rest;
  }
  const contextRecord = context as Record<string, unknown>;
  const page = typeof contextRecord.page === "string" ? contextRecord.page.trim() : "";
  if (!SYSTEM_AGENT_UI_CONTEXT_PAGE_PATTERN.test(page)) {
    const { context: _droppedContext, ...rest } = record;
    return rest;
  }
  return { ...record, context: { page } };
}
