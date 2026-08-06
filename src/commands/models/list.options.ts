/** Rejects conflicting machine-readable output modes. */
export function ensureFlagCompatibility(opts: { json?: boolean; plain?: boolean }): void {
  if (opts.json && opts.plain) {
    throw new Error("Choose either --json or --plain, not both.");
  }
}
