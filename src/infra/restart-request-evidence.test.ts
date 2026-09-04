import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGatewayRestartRequestEvidenceSync } from "./restart-request-evidence.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway restart request evidence", () => {
  it("persists owner-only restart context atomically", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-evidence-"));
    tempDirs.push(stateDir);

    expect(
      writeGatewayRestartRequestEvidenceSync({
        env: { OPENCLAW_STATE_DIR: stateDir },
        evidence: {
          reason: "cron.isolated_agent_setup_timeout",
          audit: { actor: "cron", jobId: "job-1", jobName: "Example job" },
          preflight: {
            counts: {
              queueSize: 1,
              pendingReplies: 0,
              embeddedRuns: 1,
              cronRuns: 1,
              backgroundExecSessions: 0,
              rootRequests: 0,
              activeTasks: 0,
              totalActive: 3,
            },
            blockers: [{ kind: "cron-run", count: 1, message: "1 active cron run(s)" }],
          },
          schedulerPressure: {
            pressured: true,
            eventLoopDelayP99Ms: 750,
            rssBytes: 3_000_000_000,
            configuredCronConcurrency: 2,
            effectiveCronConcurrency: 1,
          },
        },
      }),
    ).toBe(true);

    const evidencePath = path.join(stateDir, "gateway-restart-request.json");
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
      kind: string;
      pid: number;
      reason: string;
      audit: { jobId: string };
      preflight: { counts: { totalActive: number } };
      schedulerPressure: { effectiveCronConcurrency: number };
    };
    expect(evidence).toMatchObject({
      kind: "gateway-restart-request",
      pid: process.pid,
      reason: "cron.isolated_agent_setup_timeout",
      audit: { jobId: "job-1" },
      preflight: { counts: { totalActive: 3 } },
      schedulerPressure: { effectiveCronConcurrency: 1 },
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600);
    }
  });
});
