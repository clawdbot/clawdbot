import { waitFor, type PtyRun } from "./tui-pty-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const OUTPUT_TIMEOUT_MS = 120_000;

export async function waitForOutputAfter(
  run: PtyRun,
  needle: string,
  offset: number,
  timeoutMs = OUTPUT_TIMEOUT_MS,
) {
  await waitFor({
    timeoutMs,
    read: () => (run.visibleOutput().slice(offset).includes(needle) ? true : null),
    onTimeout: () =>
      new Error(
        `timed out waiting for ${JSON.stringify(needle)} after offset ${offset}\n${run.output()}`,
      ),
  });
}

export function lastOutputIndexAfter(run: PtyRun, needle: string, offset: number): number {
  const relativeIndex = run.visibleOutput().slice(offset).lastIndexOf(needle);
  return relativeIndex < 0 ? -1 : offset + relativeIndex;
}

export async function createFreshSession(run: PtyRun, newSessionPrefix: string) {
  const outputOffset = run.visibleOutput().length;
  await run.write("/new\r", { delay: false });
  await waitFor({
    timeoutMs: STARTUP_TIMEOUT_MS,
    read: () => (run.visibleOutput().includes(newSessionPrefix, outputOffset) ? true : null),
    onTimeout: () =>
      new Error(`timed out creating a fresh session after one submission\n${run.output()}`),
  });
  const newSessionOffset = run.visibleOutput().lastIndexOf(newSessionPrefix);
  // Wait for the accepted session's own idle redraw; older PTY frames can
  // replay busy messages and must never cause a second session creation.
  await waitForOutputAfter(run, "| idle", newSessionOffset);
}

export async function cleanupStartedFixture(
  startup: Promise<{ cleanup: () => Promise<void> }> | undefined,
): Promise<void> {
  if (!startup) {
    return;
  }
  let fixture: { cleanup: () => Promise<void> };
  try {
    fixture = await startup;
  } catch {
    // The setup hook already reports startup failures. Teardown only owns cleanup.
    return;
  }
  await fixture.cleanup();
}
