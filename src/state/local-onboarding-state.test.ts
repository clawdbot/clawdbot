import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  withConfigMutationExclusive,
} from "../config/config.js";
import { completeLocalSetupRecovery } from "../system-agent/setup-recovery.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  beginLocalOnboarding,
  completeLocalOnboarding,
  readLocalOnboardingState,
  readLocalOnboardingStateForConfig,
} from "./local-onboarding-state.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

const SECURITY_ACKNOWLEDGED_AT = "2026-08-02T00:00:00.000Z";

describe("local onboarding state", () => {
  it("does not create persistent state when checking an unconfigured install", async () => {
    await withOpenClawTestState({ label: "local-onboarding-empty" }, async (state) => {
      expect(readLocalOnboardingState(state.configPath, { env: state.env })).toBeUndefined();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("isolates receipts by configuration path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-paths" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "first-run",
        nowMs: 100,
        database,
      });

      expect(readLocalOnboardingState(state.configPath, database)).toEqual(first);
      expect(readLocalOnboardingState(state.path("other.json"), database)).toBeUndefined();
      expect(first).toMatchObject({ status: "pending", runId: "first-run", startedAtMs: 100 });
    });
  });

  it("preserves the pending owner across repeated activation commits", async () => {
    await withOpenClawTestState({ label: "local-onboarding-owner" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "first-run",
        database,
      });
      const second = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("other-workspace"),
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "second-run",
        database,
      });

      expect(second).toEqual(first);
      expect(
        completeLocalOnboarding({ configPath: state.configPath, runId: "wrong", database }),
      ).toBe(false);
      expect(readLocalOnboardingState(state.configPath, database)?.status).toBe("pending");
      expect(
        completeLocalOnboarding({
          configPath: state.configPath,
          runId: "first-run",
          nowMs: 200,
          database,
        }),
      ).toBe(true);
      expect(readLocalOnboardingState(state.configPath, database)).toMatchObject({
        ...first,
        status: "completed",
        completedAtMs: 200,
      });
    });
  });

  it("prevents an interrupted pre-reset run from completing its replacement", async () => {
    await withOpenClawTestState({ label: "local-onboarding-reset" }, async (state) => {
      const database = { env: state.env };
      beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "stale-run",
        database,
      });
      const replacement = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "new-run",
        replace: true,
        expectedRunId: "stale-run",
        database,
      });

      expect(
        completeLocalOnboarding({ configPath: state.configPath, runId: "stale-run", database }),
      ).toBe(false);
      expect(readLocalOnboardingState(state.configPath, database)).toEqual(replacement);
      expect(
        completeLocalOnboarding({ configPath: state.configPath, runId: "new-run", database }),
      ).toBe(true);
    });
  });

  it("completes the same run idempotently without changing its original timestamp", async () => {
    await withOpenClawTestState({ label: "local-onboarding-idempotent" }, async (state) => {
      const database = { env: state.env };
      beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "completed-run",
        database,
      });

      expect(
        completeLocalOnboarding({
          configPath: state.configPath,
          runId: "completed-run",
          nowMs: 100,
          database,
        }),
      ).toBe(true);
      expect(
        completeLocalOnboarding({
          configPath: state.configPath,
          runId: "completed-run",
          nowMs: 200,
          database,
        }),
      ).toBe(true);
      expect(
        completeLocalOnboarding({
          configPath: state.configPath,
          runId: "different-run",
          nowMs: 300,
          database,
        }),
      ).toBe(false);
      expect(readLocalOnboardingState(state.configPath, database)).toMatchObject({
        status: "completed",
        runId: "completed-run",
        completedAtMs: 100,
      });
    });
  });

  it("completes its validated owner idempotently without rewriting the locked config", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-completion" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: { default: true } },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "locked-owner",
        database,
      });
      const originalConfig = fs.readFileSync(state.configPath, "utf8");

      const first = await completeLocalSetupRecovery({
        owner,
        appliedConfigPath: state.configPath,
      });
      const completed = readLocalOnboardingState(state.configPath, database);
      const second = await completeLocalSetupRecovery({
        owner,
        appliedConfigPath: state.configPath,
      });

      expect(first.path).toBe(state.configPath);
      expect(second.path).toBe(state.configPath);
      expect(completed).toMatchObject({ status: "completed", runId: owner.runId });
      expect(readLocalOnboardingState(state.configPath, database)).toEqual(completed);
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
    });
  });

  it("rejects a canonical config mutation that wins the completion lock", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-lock-race" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: { default: true } },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "racing-owner",
        database,
      });
      const optimisticSnapshot = await readConfigFileSnapshot();
      expect(optimisticSnapshot.sourceConfig.wizard?.securityAcknowledgedAt).toBe(
        SECURITY_ACKNOWLEDGED_AT,
      );
      let notifyLockHeld!: () => void;
      let releaseMutation!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        notifyLockHeld = resolve;
      });
      const mutationReleased = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const competingMutation = withConfigMutationExclusive(async (lockedConfig) => {
        notifyLockHeld();
        await mutationReleased;
        await replaceConfigFile({
          nextConfig: {
            ...lockedConfig,
            wizard: {
              ...lockedConfig.wizard,
              securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
            },
          },
        });
      });
      await lockHeld;
      const completionFails = expect(
        completeLocalSetupRecovery({ owner, appliedConfigPath: optimisticSnapshot.path }),
      ).rejects.toThrow("onboarding configuration changed before setup could complete");

      releaseMutation();
      await competingMutation;
      await completionFails;

      expect(readLocalOnboardingState(state.configPath, database)).toEqual(owner);
      expect((await readConfigFileSnapshot()).sourceConfig.wizard?.securityAcknowledgedAt).toBe(
        "2026-08-03T00:00:00.000Z",
      );
    });
  });

  it("rejects another receipt owner and an applied config at a different path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-ownership" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: { default: true } },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "real-owner",
        database,
      });

      await expect(
        completeLocalSetupRecovery({
          owner: { ...owner, runId: "different-owner" },
          appliedConfigPath: state.configPath,
        }),
      ).rejects.toThrow("Another onboarding run replaced this setup operation");
      await expect(
        completeLocalSetupRecovery({
          owner,
          appliedConfigPath: state.path("another-config.json"),
        }),
      ).rejects.toThrow("onboarding configuration changed before setup could complete");

      expect(readLocalOnboardingState(state.configPath, database)).toEqual(owner);
    });
  });

  it("accepts the same run completing between the optimistic read and SQLite transaction", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completion-race" }, async (state) => {
      const database = { env: state.env };
      beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "racing-run",
        database,
      });
      let databaseReads = 0;

      const completed = completeLocalOnboarding({
        configPath: state.configPath,
        runId: "racing-run",
        nowMs: 300,
        get database() {
          if (++databaseReads === 2) {
            expect(
              completeLocalOnboarding({
                configPath: state.configPath,
                runId: "racing-run",
                nowMs: 200,
                database,
              }),
            ).toBe(true);
          }
          return database;
        },
      });

      expect(completed).toBe(true);
      expect(readLocalOnboardingState(state.configPath, database)).toMatchObject({
        status: "completed",
        runId: "racing-run",
        completedAtMs: 200,
      });
    });
  });

  it("does not let a concurrent missing-config run replace the active owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-concurrent" }, async (state) => {
      const database = { env: state.env };
      const active = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "active-run",
        database,
      });
      const concurrent = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("concurrent-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "concurrent-run",
        replace: true,
        expectedRunId: "stale-reset-run",
        database,
      });

      expect(concurrent).toEqual(active);
      expect(readLocalOnboardingState(state.configPath, database)).toEqual(active);
    });
  });

  it("does not let a delayed concurrent run reopen a completed owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-owner" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "completed-run",
        database,
      });
      expect(
        completeLocalOnboarding({ configPath: state.configPath, runId: first.runId, database }),
      ).toBe(true);
      const completed = readLocalOnboardingState(state.configPath, database);

      for (const replacement of [
        {},
        { replace: true },
        { replace: true, expectedRunId: "other-run" },
      ]) {
        const concurrent = beginLocalOnboarding({
          configPath: state.configPath,
          workspace: state.path("concurrent-workspace"),
          securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
          runId: "delayed-run",
          ...replacement,
          database,
        });
        expect(concurrent).toEqual(completed);
        expect(readLocalOnboardingState(state.configPath, database)).toEqual(completed);
      }
    });
  });

  it("replaces a completed owner only when reset observed its exact run", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-reset" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "observed-completed-run",
        database,
      });
      expect(
        completeLocalOnboarding({ configPath: state.configPath, runId: first.runId, database }),
      ).toBe(true);

      const replacement = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "replacement-run",
        replace: true,
        expectedRunId: first.runId,
        database,
      });

      expect(replacement).toMatchObject({ status: "pending", runId: "replacement-run" });
      expect(readLocalOnboardingState(state.configPath, database)).toEqual(replacement);
    });
  });

  it("binds receipts to the acknowledged configuration identity", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-identity" }, async (state) => {
      const database = { env: state.env };
      const pending = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "original-run",
        database,
      });

      expect(
        readLocalOnboardingStateForConfig(
          state.configPath,
          { wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT } },
          database,
        ),
      ).toEqual(pending);
      expect(
        readLocalOnboardingStateForConfig(
          state.configPath,
          { wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" } },
          database,
        ),
      ).toBeUndefined();
      expect(readLocalOnboardingStateForConfig(state.configPath, {}, database)).toBeUndefined();
      expect(readLocalOnboardingState(state.configPath, database)).toEqual(pending);
    });
  });
});
