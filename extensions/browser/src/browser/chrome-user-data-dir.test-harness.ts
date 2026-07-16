import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

type ChromeUserDataDirRef = {
  dir: string;
};

export function installChromeUserDataDirHooks(chromeUserDataDir: ChromeUserDataDirRef): void {
  beforeAll(async () => {
    chromeUserDataDir.dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-user-data-"));
  });

  afterAll(async () => {
    await fs.rm(chromeUserDataDir.dir, { recursive: true, force: true });
  });
}
