import { describe, expect, it, vi } from "vitest";
import type { DoctorSessionSqliteReport } from "../commands/doctor-session-sqlite-types.js";
import {
  inspectStartupSessionMigrationPrerequisites,
  type SessionStartupPreflightResult,
} from "./server-startup-session-migration.js";

type InspectParams = Parameters<typeof inspectStartupSessionMigrationPrerequisites>[0];
type RunDoctorSessionSqlite = NonNullable<
  NonNullable<InspectParams["deps"]>["runDoctorSessionSqlite"]
>;

function makeCfg(): InspectParams["cfg"] {
  return {
    agents: { defaults: {} },
    session: { store: "/tmp/{agentId}/sessions.json" },
  };
}

function makeSessionSqliteValidation(
  report: Partial<DoctorSessionSqliteReport> = {},
): RunDoctorSessionSqlite {
  return vi.fn().mockResolvedValue({
    mode: "validate",
    targets: [],
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      targets: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    },
    ...report,
  });
}

describe("inspectStartupSessionMigrationPrerequisites", () => {
  it("reports the same non-warning issue that blocks startup", async () => {
    const cfg = makeCfg();
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-preflight" };
    const runDoctorSessionSqlite = makeSessionSqliteValidation({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 0,
          importedTranscriptEvents: 0,
          issues: [{ code: "store_unreadable", message: "/tmp/sessions.json: invalid JSON" }],
          legacyEntries: 0,
          referencedTranscriptFiles: 0,
          sqliteEntries: 0,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
    });

    const result = await inspectStartupSessionMigrationPrerequisites({
      cfg,
      env,
      deps: { runDoctorSessionSqlite },
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "validate",
    });
    expect(result).toEqual({
      status: "blocked",
      findings: [
        {
          id: "main/store_unreadable/1",
          code: "store_unreadable",
          message:
            "Session SQLite startup migration for agent main is blocked: /tmp/sessions.json: invalid JSON",
          remediation: [
            'Run "openclaw doctor --session-sqlite inspect --session-sqlite-all-agents" for details.',
          ],
          agentId: "main",
        },
      ],
    } satisfies SessionStartupPreflightResult);
  });

  it("does not block on startup warning issues or an absent legacy store", async () => {
    const warning = makeSessionSqliteValidation({
      targets: [
        {
          agentId: "main",
          archivedTranscriptFiles: [],
          archivedUnreferencedJsonlFiles: [],
          importedEntries: 0,
          importedTranscriptEvents: 0,
          issues: [{ code: "transcript_missing", message: "/tmp/missing.jsonl" }],
          legacyEntries: 1,
          referencedTranscriptFiles: 1,
          sqliteEntries: 0,
          sqlitePath: "/tmp/openclaw-agent.sqlite",
          storePath: "/tmp/sessions.json",
          unreferencedJsonlFiles: [],
          validatedEntries: 0,
          validatedTranscriptEvents: 0,
        },
      ],
    });
    const missingStore = makeSessionSqliteValidation();

    await expect(
      inspectStartupSessionMigrationPrerequisites({
        cfg: makeCfg(),
        deps: { runDoctorSessionSqlite: warning },
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      inspectStartupSessionMigrationPrerequisites({
        cfg: makeCfg(),
        deps: { runDoctorSessionSqlite: missingStore },
      }),
    ).resolves.toEqual({ status: "ready" });
  });

  it("returns indeterminate when read-only validation cannot complete", async () => {
    const runDoctorSessionSqlite = vi.fn().mockRejectedValue(new Error("permission denied"));

    await expect(
      inspectStartupSessionMigrationPrerequisites({
        cfg: makeCfg(),
        deps: { runDoctorSessionSqlite },
      }),
    ).resolves.toEqual({
      status: "indeterminate",
      reason:
        "Session SQLite startup prerequisites could not be inspected: Error: permission denied",
    });
  });
});
