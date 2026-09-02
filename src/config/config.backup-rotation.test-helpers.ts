// Provides fixture helpers for config backup rotation tests.
import path from "node:path";
import { expect } from "vitest";

/** Platform flag shared by config backup permission tests. */
export const IS_WINDOWS = process.platform === "win32";

export function resolveConfigPathFromTempState(fileName = "openclaw.json"): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("Expected OPENCLAW_STATE_DIR to be set by withTempHome");
  }
  return path.join(stateDir, fileName);
}

export function expectPosixMode(statMode: number, expectedMode: number): void {
  if (IS_WINDOWS) {
    return;
  }
  expect(statMode & 0o777).toBe(expectedMode);
}
