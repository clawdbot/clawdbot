// Formats finalized message context into prompt-visible text.
/** Resolves normalized text for slash/bang command parsing. */
export function resolveCommandContextText(ctx: { commandText: string }): string {
  return ctx.commandText.trim();
}

/** Checks whether the inbound context carries an explicit command prefix. */
export function hasExplicitCommandContextText(ctx: { commandText: string }): boolean {
  const text = resolveCommandContextText(ctx);
  return text.startsWith("/") || text.startsWith("!");
}
