import { describe, expect, it } from "vitest";
import { z } from "zod";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  isPendingControlPlaneUpdateRestartSentinel,
} from "./update-control-plane-sentinel.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";

async function withRestartSentinelStateDir(run: () => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-sentinel-" }, async (tempDir) => {
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, run);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
}

describe("control-plane update restart sentinel", () => {
  it("preserves advisory step classification through the typed sentinel round trip", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel(
        buildUpdateRestartSentinelPayload({
          result: {
            status: "error",
            mode: "npm",
            steps: [
              {
                name: "post-install doctor",
                command: "openclaw doctor",
                cwd: "/tmp/openclaw",
                durationMs: 1,
                exitCode: 86,
                advisory: {
                  kind: "package-post-install-doctor",
                  message: "private advisory detail",
                },
              },
            ],
            durationMs: 1,
          },
          meta: {},
        }),
      );

      const steps = (await readRestartSentinel())?.payload.stats?.steps;
      expect(steps).toEqual([
        expect.objectContaining({ name: "post-install doctor", advisory: true }),
      ]);
      expect(JSON.stringify(steps)).not.toContain("private advisory detail");
    });
  });

  it.each([
    { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    { serviceRestartSafe: true, version: "1.0.0", service: "failed" },
    {
      serviceRestartSafe: true,
      version: "1.0.0",
      buildId: "restored-git-build",
      service: "healthy",
    },
    { serviceRestartSafe: false, reason: "state-migration-started" },
  ] as const)(
    "preserves recovery through the typed sentinel round trip ($serviceRestartSafe)",
    async (recovery) => {
      await withRestartSentinelStateDir(async () => {
        await writeRestartSentinel(
          buildUpdateRestartSentinelPayload({
            result: { status: "error", mode: "npm", recovery, steps: [], durationMs: 1 },
            meta: {},
          }),
        );
        expect((await readRestartSentinel())?.payload.stats?.recovery).toEqual(recovery);
      });
    },
  );

  it.each([true, false])(
    "keeps package rollback diagnostics out of prior-runtime sentinel recovery (%s)",
    async (packageRollbackVerified) => {
      const priorUnsafeRecoverySchema = z.strictObject({
        serviceRestartSafe: z.literal(false),
        reason: z.enum([
          "source-rollback-failed",
          "state-migration-started",
          "manager-unavailable",
          "deps-install-failed",
          "build-failed",
          "rollback-checkout-dirty",
          "runtime-verification-failed",
        ]),
      });
      const recovery = {
        serviceRestartSafe: false as const,
        reason: "runtime-verification-failed" as const,
        packageRollbackVerified,
      };
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "error", mode: "npm", recovery, steps: [], durationMs: 1 },
        meta: {},
      });

      expect(recovery.packageRollbackVerified).toBe(packageRollbackVerified);
      expect(payload.stats?.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(priorUnsafeRecoverySchema.safeParse(payload.stats?.recovery).success).toBe(true);

      await withRestartSentinelStateDir(async () => {
        await writeRestartSentinel(payload);
        expect((await readRestartSentinel())?.payload.stats?.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
      });
    },
  );

  it("reports a successful same-revision Git run as already current", () => {
    const payload = buildUpdateRestartSentinelPayload({
      result: {
        status: "ok",
        mode: "git",
        before: { sha: "aaaaaaaa" },
        after: { sha: "aaaaaaaa" },
        steps: [],
        durationMs: 42,
      },
      meta: {},
      nowMs: 1,
    });

    expect(payload.status).toBe("skipped");
    expect(payload.stats?.reason).toBe("already-current");
    expect(payload.continuation).toBeUndefined();
  });

  it("keeps restart-health-pending sentinels continuation-free until final success", () => {
    const result = {
      runId: "ab186c13-181b-4cf7-a882-c179928539e6",
      status: "ok" as const,
      mode: "npm" as const,
      root: "/tmp/openclaw",
      before: { version: "2026.4.23" },
      after: { version: "2026.4.24" },
      steps: [],
      durationMs: 42,
      recovery: { serviceRestartSafe: true, version: "2026.4.24" } as const,
    };
    const meta = {
      target: "version 2026.4.24",
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "Check the running version and finish the update report.",
    };

    const pendingResult = buildControlPlaneUpdateRestartHealthPendingResult(result);
    const pendingPayload = buildUpdateRestartSentinelPayload({
      result: pendingResult,
      meta,
      nowMs: 1,
    });

    expect(pendingPayload.status).toBe("skipped");
    expect(pendingPayload.stats).toMatchObject({
      runId: result.runId,
      reason: "restart-health-pending",
    });
    expect(pendingPayload.continuation).toBeUndefined();
    expect(isPendingControlPlaneUpdateRestartSentinel(pendingPayload)).toBe(true);

    const finalPayload = buildUpdateRestartSentinelPayload({
      result,
      meta,
      nowMs: 2,
    });

    expect(finalPayload.status).toBe("ok");
    expect(finalPayload.stats).toMatchObject({
      runId: result.runId,
      target: "version 2026.4.24",
      recovery: { serviceRestartSafe: true },
    });
    expect(finalPayload.continuation).toEqual({
      kind: "agentTurn",
      message: "Check the running version and finish the update report.",
    });
    expect(isPendingControlPlaneUpdateRestartSentinel(finalPayload)).toBe(false);
  });
});
