import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  execBusctlUser: async (env: Record<string, string | undefined>) => ({
    code: 1,
    stdout: "",
    stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT}.service not found.`,
  }),
}));

import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";

describe.skipIf(process.platform === "win32")("systemd publication directory creation", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-unit-mode-")));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "uses safe new directory modes without changing existing ones under umask 0002 (existing=%s)",
    async (existing) => {
      const env = {
        HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_SYSTEMD_UNIT: "openclaw-mode-proof",
      };
      const directory = path.join(env.HOME, ".config/systemd/user");
      const unit = path.join(directory, `${env.OPENCLAW_SYSTEMD_UNIT}.service`);
      await fs.mkdir(env.HOME, { mode: 0o700 });
      if (existing) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      }
      const mkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (args[0] !== directory) {
          return mkdir(...args);
        }
        // Vitest uses threads, where changing umask is forbidden. A child applies
        // the real kernel mask to the exact mkdir options supplied by publication.
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "import { mkdirSync } from 'node:fs'; process.umask(0o002); mkdirSync(process.argv[1], JSON.parse(process.argv[2]));",
            directory,
            JSON.stringify(args[1] ?? {}),
          ],
          { timeout: 10_000 },
        );
        return undefined;
      });
      const chmod = vi.spyOn(fs, "chmod");
      const contents = "[Service]\nExecStart=/usr/bin/node gateway\n";

      await withSystemdDefinitionMutation(env, env, (mutation) =>
        mutation.publish(unit, contents, 0o644),
      );

      expect(await fs.readFile(unit, "utf8")).toBe(contents);
      expect((await fs.stat(directory)).mode & 0o777).toBe(existing ? 0o700 : 0o755);
      expect(chmod).not.toHaveBeenCalled();
    },
  );
});
