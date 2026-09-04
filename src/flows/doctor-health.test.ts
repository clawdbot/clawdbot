// Install fixture mocks before importing the real Doctor flow.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { sessionParticipantsSchemaSql } from "../state/openclaw-agent-session-participants-schema.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const postInstallAdvisory: NonNullable<DoctorHealthFlowContext["postInstallDoctorResult"]> = {
  status: "advisory",
  advisory: {
    kind: "package-post-install-doctor",
    message: "recoverable plugin repair",
    reason: "deferred-configured-plugin-repair",
    details: ["plugin repair deferred"],
  },
};

const { mocks } = await import("./doctor-health.test-support.js");

describe("runDoctorHealthFlow", () => {
  it("reports a cron ownership refusal instead of a recoverable post-install advisory", async () => {
    mocks.runContributions.mockImplementation(async (ctx) => {
      ctx.configWriteRefusal = "cron-owner-safety";
      ctx.postInstallDoctorResult = postInstallAdvisory;
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    vi.stubEnv(
      "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
      "/tmp/openclaw-update-doctor-result.json",
    );

    try {
      await runDoctorHealthFlow(runtime, {});
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.outro).toHaveBeenCalledWith("Doctor finished, but config fixes were not applied.");
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(86);
    expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
  });

  it.each([{ repair: true }, { yes: true }])(
    "refuses blocked required migration for %j, then completes after the writer releases",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const initial = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        initial.db.exec(
          "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
        );
        closeOpenClawAgentDatabasesForTest();
        const before = fs.readFileSync(initial.path);
        const leaseId = claimOpenClawAgentDatabaseLease({
          agentId: "main",
          path: initial.path,
          env: state.env,
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyMediaPersistence();
          ctx.runtime.log(result.warnings.join("\n"));
          if (result.warnings.length > 0 && (ctx.options.repair || ctx.options.yes)) {
            ctx.postInstallDoctorResult = postInstallAdvisory;
          }
        });
        try {
          // Diagnostic-only Doctor retains advisory behavior while the writer is live.
          await runDoctorHealthFlow(runtime, { nonInteractive: true });
          expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          mocks.outro.mockClear();
          vi.stubEnv(
            "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
            state.path("advisory.json"),
          );
          await runCommandWithRuntime(runtime, () =>
            runDoctorHealthFlow(runtime, { ...options, nonInteractive: true }),
          );
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringMatching(/Doctor.*database readiness.*schema version 17/),
          );
          expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
          expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining("still open in another process"),
          );
          expect(fs.readFileSync(initial.path)).toEqual(before);
          expect(
            openOpenClawStateDatabase({ env: state.env })
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
              .get(leaseId),
          ).toEqual({ lease_id: leaseId });
        } finally {
          vi.unstubAllEnvs();
          releaseOpenClawAgentDatabaseLease(leaseId, { env: state.env });
        }
        runtime.exit.mockClear();
        await runDoctorHealthFlow(runtime, { ...options, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const reopened = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          reopened.db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["default", "configured"])(
    "refuses failed migration of an unregistered %s store",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath =
          layout === "configured" ? state.path("custom", "sessions.json") : undefined;
        const cfg: OpenClawConfig = storePath ? { session: { store: storePath } } : {};
        mocks.config.mockReturnValue(cfg);
        const configuredPath = storePath
          ? resolveSqliteTargetFromSessionStorePath(storePath, {
              agentId: "main",
              defaultAgentId: "main",
              env: state.env,
            }).path
          : undefined;
        const initial = openOpenClawAgentDatabase({
          agentId: "main",
          env: state.env,
          ...(configuredPath ? { path: configuredPath } : {}),
        });
        initial.db.exec(
          "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
        );
        initial.db.exec(withLegacySessionParticipantsSchema(sessionParticipantsSchemaSql()));
        initial.db.exec(
          "CREATE INDEX unknown_participant_dependency ON session_participants(actor_id);",
        );
        closeOpenClawAgentDatabasesForTest();
        unregisterOpenClawAgentDatabase({ agentId: "main", path: initial.path, env: state.env });
        const before = fs.readFileSync(initial.path);
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyMediaPersistence({
            configuredAgentDatabaseTargets: configuredPath
              ? [{ agentId: "main", path: configuredPath }]
              : [],
          });
          ctx.runtime.log(result.warnings.join("\n"));
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("unknown indexes, views, or triggers"),
        );
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(/Doctor.*database readiness.*schema version 17/),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(fs.readFileSync(initial.path)).toEqual(before);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT * FROM agent_databases")
            .all(),
        ).toEqual([]);
      });
    },
  );

  it("keeps archive repair failures advisory after required database migration succeeds", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const archive = await state.writeText(
        "agents/main/sessions/corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
        "invalid JSON\n",
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      mocks.runContributions.mockImplementation(async (ctx) => {
        const result = await migrateLegacyMediaPersistence();
        ctx.runtime.log(result.warnings.join("\n"));
      });
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Skipped archived transcript media migration"),
      );
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(fs.readFileSync(archive, "utf8")).toBe("invalid JSON\n");
    });
  });

  it.each(["default", "configured"] as const)(
    "fails repair when a startup-blocking %s legacy session store remains",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath =
          layout === "configured"
            ? state.path("custom", "sessions.json")
            : state.statePath("agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, '{"agent:main:legacy":');
        mocks.config.mockReturnValue(
          layout === "configured" ? { session: { store: storePath } } : {},
        );
        const before = fs.readFileSync(storePath);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );

        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Legacy session store requires migration"),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(fs.readFileSync(storePath)).toEqual(before);
      });
    },
  );

  it("fails public repair after the Gateway lock skips session import", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = await state.writeText(
        "agents/main/sessions/sessions.json",
        JSON.stringify({
          "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
        }),
      );
      const before = fs.readFileSync(storePath);
      const gatewayLock = await acquireGatewayLock({
        allowInTests: true,
        env: state.env,
        port: 19566,
      });
      if (!gatewayLock) {
        throw new Error("expected Gateway lock");
      }
      mocks.runContributions.mockImplementation(async (ctx) => {
        await noteSessionTranscriptHealth({
          cfg: ctx.cfg,
          env: state.env,
          shouldRepair: true,
        });
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      try {
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
      } finally {
        await gatewayLock.release();
      }

      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Legacy session store requires migration"),
      );
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      expect(fs.readFileSync(storePath)).toEqual(before);
    });
  });

  it.each(["configured", "sandbox"] as const)(
    "refuses incomplete %s workspace cleanup with current SQLite schemas, then completes on retry",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const workspaceDir = state.statePath("secondary-workspace");
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              primary: { workspace: state.workspaceDir },
              secondary:
                kind === "configured"
                  ? { workspace: workspaceDir }
                  : {
                      workspace: state.path("secondary-host-workspace"),
                      sandbox: {
                        mode: "all",
                        scope: "shared",
                        workspaceRoot: workspaceDir,
                        workspaceAccess: "none",
                      },
                    },
            },
          },
        };
        mocks.config.mockReturnValue(cfg);
        const sourcePath = await state.writeJson(
          "secondary-workspace/openclaw-workspace-state.json",
          {
            version: 1,
            setupCompletedAt: "2026-07-15T00:00:00.000Z",
          },
        );
        openOpenClawStateDatabase({ env: state.env });
        let failCleanup = true;
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyWorkspaceState({
            stateDir: state.stateDir,
            env: state.env,
            detected: detectLegacyWorkspaceState({
              cfg: ctx.cfg,
              stateDir: state.stateDir,
              env: state.env,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
            }),
            ...(failCleanup
              ? {
                  removeSource: () => {
                    throw new Error("simulated unlink failure");
                  },
                }
              : {}),
          });
          ctx.runtime.log(result.warnings.join("\n"));
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runCommandWithRuntime(runtime, () =>
          runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
        );
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("legacy cleanup failed"));
        expect(readWorkspaceStateSnapshot(workspaceDir).setup.setupCompletedAt).toBe(
          "2026-07-15T00:00:00.000Z",
        );
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
        expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).toThrow(
          /requires migration/,
        );
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringMatching(/workspace.*requires migration/),
        );
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");

        failCleanup = false;
        runtime.exit.mockClear();
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
        expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir })).not.toThrow();
      });
    },
  );

  it.each(["missing-state", "missing-agent", "current"])(
    "accepts %s databases without creating or repairing them",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        let agentPath: string | undefined;
        if (scenario !== "missing-state") {
          agentPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
          closeOpenClawAgentDatabasesForTest();
          if (scenario === "missing-agent") {
            fs.unlinkSync(agentPath);
          }
        }
        const before =
          agentPath && fs.existsSync(agentPath) ? fs.readFileSync(agentPath) : undefined;
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
        if (agentPath && before) {
          expect(fs.readFileSync(agentPath)).toEqual(before);
        } else {
          expect(fs.existsSync(agentPath ?? resolveOpenClawStateSqlitePath(state.env))).toBe(false);
        }
      });
    },
  );
});
