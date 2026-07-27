// Doctor auth tests cover migrating a non-main agent whose legacy JSON holds an
// OAuth credential the main store already owns at a newer expiry.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const states: OpenClawTestState[] = [];

function makePrompter(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => true),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => true),
    confirmRuntimeRepair: vi.fn(async () => true),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: { shouldRepair: true, shouldForce: false },
  } as unknown as DoctorPrompter;
}

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState();
  states.push(state);
  return state;
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  while (states.length > 0) {
    await states.pop()?.cleanup();
  }
});

describe("auth profile migration with an inherited main OAuth credential", () => {
  it("completes and removes the legacy JSON instead of failing verification", async () => {
    const state = await makeTestState();

    // Main is already migrated and owns a live copy of the same profile id.
    // This is the real shape: doctor migrates main successfully, then fails on
    // the remaining agent, so main's SQLite store is already populated.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:shared@example.test": {
            type: "oauth",
            provider: "openai",
            access: "fake-main-access",
            refresh: "fake-main-refresh",
            expires: Date.parse("2027-01-01T00:00:00.000Z"),
          },
        },
      } as AuthProfileStore,
      state.agentDir(),
      { syncExternalCli: false },
    );

    // A non-main agent holds an older copy of that same profile. The save path
    // drops it as inherited from main, which previously read as data loss and
    // aborted the migration, leaving this file on disk.
    const secondaryAgentDir = state.agentDir("gadget");
    const secondaryAuthPath = await state.writeText(
      "agents/gadget/agent/auth-profiles.json",
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai:shared@example.test": {
              type: "oauth",
              provider: "openai",
              access: "fake-stale-access",
              refresh: "fake-stale-refresh",
              expires: Date.parse("2026-06-20T00:00:00.000Z"),
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: { agents: { list: [{ id: "gadget", agentDir: secondaryAgentDir }] } },
      prompter: makePrompter(),
      env: state.env,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    expect(result.warnings).toStrictEqual([]);
    // The runtime refuses to start while a legacy credential file remains, so
    // leaving this behind is what turned a failed verification into a boot loop.
    expect(fs.existsSync(secondaryAuthPath)).toBe(false);
    // Nothing is lost: main still owns the newer credential.
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:shared@example.test"],
    ).toMatchObject({ type: "oauth", access: "fake-main-access" });
  });
});
