/** Preserve meaningful spacing while treating an all-whitespace draft as empty. */
export function normalizeChatComposerDraft(value: string): string {
  return value.trim().length === 0 ? "" : value;
}
