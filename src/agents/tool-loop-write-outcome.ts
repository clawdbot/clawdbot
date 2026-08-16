export function isWriteNoProgressOutcome(details: Record<string, unknown>): boolean {
  // The built-in no-op result echoes the requested path in display text.
  // Its structured `changed: false` flag is the semantic no-progress contract.
  return details.changed === false;
}
