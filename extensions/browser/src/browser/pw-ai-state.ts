/**
 * Playwright AI load-state marker.
 *
 * Tracks whether the Playwright-backed browser helper barrel has been imported
 * so diagnostics can distinguish unloaded from unavailable modules.
 */
let pwAiLoaded = false;

/** Mark the Playwright AI helper module as loaded. */
export function markPwAiLoaded(): void {
  pwAiLoaded = true;
}

/** Return true once the Playwright AI helper module has been imported. */
export function isPwAiLoaded(): boolean {
  return pwAiLoaded;
}
