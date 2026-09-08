import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("creates, restores, and verifies a 256 MiB Git backup with a 256 MiB heap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-streaming-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await fs.mkdir(home);
  await fs.mkdir(tmp);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=256",
        "--import",
        "tsx",
        fileURLToPath(new URL("./git-backup-streaming.test-support.ts", import.meta.url)),
        root,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: tmp,
          TEMP: tmp,
          TMP: tmp,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 120_000,
      },
    );
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: 4096,
      logicalBytes: 256 * 1024 * 1024,
      sha256: "6f89fbefed73bed483dc401fc9290ac43dcc1a09197d431fbcae35c5841ff980",
      restored: true,
      verified: true,
      gitFailureCleaned: true,
    });
    expect((await fs.readdir(tmp)).filter((name) => name.startsWith("openclaw-git-"))).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 130_000);
