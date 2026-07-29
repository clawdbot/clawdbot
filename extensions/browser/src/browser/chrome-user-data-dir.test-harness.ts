/**
 * Chrome user-data-dir Vitest harness.
 *
 * Creates and removes an isolated Chrome profile directory for browser tests
 * that need filesystem-backed profile state.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

type ChromeUserDataDirRef = {
  dir: string;
};

/** Install beforeAll/afterAll hooks for a temporary Chrome user-data-dir. */
export function installChromeUserDataDirHooks(chromeUserDataDir: ChromeUserDataDirRef): void {
  beforeAll(async () => {
    chromeUserDataDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-user-data-"));
  });

  afterAll(async () => {
    await fs.rm(chromeUserDataDir.dir, { recursive: true, force: true });
  });
}
