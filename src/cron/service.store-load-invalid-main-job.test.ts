import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-load-"));
  return {
    dir,
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

describe("CronService store load", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (!tempDir) {
      return;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("skips invalid main jobs with agentTurn payloads loaded from disk", async () => {
    const { dir, storePath } = await makeStorePath();
    tempDir = dir;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();

    const job = {
      id: "job-1",
      enabled: true,
      createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      schedule: { kind: "at", at: "2025-12-13T00:00:01.000Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "bad" },
      state: {},
      name: "bad",
    } satisfies CronJob;

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main cron jobs require payload\.kind/i);

    cron.stop();
  });
});
