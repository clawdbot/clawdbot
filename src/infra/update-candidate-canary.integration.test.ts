import * as childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

it(
  "boots the built candidate to started and ready, then tears down its isolated process group",
  { timeout: 330_000 },
  async () => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "canary-boundary-")),
    );
    const spawned = vi.mocked(childProcess.spawn);
    spawned.mockClear();
    try {
      const result = await validateUpdateCandidateCanary({
        root: process.cwd(),
        stateDir,
        config: { gateway: { mode: "local" } },
        env: { PATH: process.env.PATH },
        timeoutMs: 300_000,
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      const phases = result.logTail.filter((line) => /^(startupz|readyz):/u.test(line));
      expect(phases).toHaveLength(2);
      expect(phases[0]).toContain("startupz: started");
      expect(phases[1]).toContain("readyz: ready");
      expect(await fs.readdir(stateDir)).toEqual([]);
      const callIndex = spawned.mock.calls.findIndex(
        ([, args]) => Array.isArray(args) && args.includes("--update-canary"),
      );
      const gateway = spawned.mock.results[callIndex]?.value as childProcess.ChildProcess;
      expect(gateway.pid).toBeGreaterThan(0);
      expect(() =>
        process.kill(process.platform === "win32" ? gateway.pid! : -gateway.pid!, 0),
      ).toThrow();
      const options = spawned.mock.calls[callIndex]?.[2] as childProcess.SpawnOptions;
      await expect(fs.access(options.env!.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      spawned.mockClear();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);
