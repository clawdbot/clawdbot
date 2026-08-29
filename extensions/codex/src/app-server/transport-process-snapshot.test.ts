import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readCodexAppServerProcessSnapshot } from "./transport-process-snapshot.js";

describe.skipIf(process.platform === "win32" || process.platform === "linux")(
  "Codex POSIX process inspector",
  () => {
    it.for(["unavailable", "hung"] as const)(
      "settles a %s ps inspector without leaking its process",
      async (mode, ctx) => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ps-deadline-"));
        const inspectorPath = path.join(tempDir, "ps");
        const pidPath = path.join(tempDir, "inspector.pid");
        let inspectorPid: number | undefined;
        ctx.onTestFinished(async () => {
          const pid = inspectorPid ?? Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
          if (pid && isPidAlive(pid)) {
            const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
            if (command.includes(inspectorPath)) {
              process.kill(pid, "SIGKILL");
            }
          }
          await fs.rm(tempDir, { recursive: true, force: true });
        });
        await fs.writeFile(
          inspectorPath,
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CODEX_TEST_PS_PID_FILE, String(process.pid));
${mode === "unavailable" ? "process.exit(1);" : "setInterval(() => {}, 1000);"}
`,
          { mode: 0o755 },
        );
        await withEnvAsync(
          {
            PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
            CODEX_TEST_PS_PID_FILE: pidPath,
          },
          async () => {
            const startedAt = Date.now();
            const budgetMs = 1_000;
            const result = await readCodexAppServerProcessSnapshot(startedAt + budgetMs);
            const pid = Number(await fs.readFile(pidPath, "utf8"));
            inspectorPid = pid;
            expect(pid).toBeGreaterThan(0);
            expect(result).toBeUndefined();
            // Allow scheduler jitter, but not the inspector's unbounded event loop.
            expect(Date.now() - startedAt).toBeLessThan(budgetMs + 500);
            await expect.poll(() => isPidAlive(pid)).toBe(false);
          },
        );
      },
    );
  },
);
