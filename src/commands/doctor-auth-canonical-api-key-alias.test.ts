// Historical API-key aliases migrate directly into the receipted SQLite auth owner.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

const states: OpenClawTestState[] = [];
const secretRef = { source: "env", provider: "default", id: "MY_PROVIDER_API_KEY" } as const;

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-canonical-api-key-",
    env: { OPENCLAW_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: undefined },
  });
  states.push(state);
  return state;
}

async function writeProfiles(
  state: OpenClawTestState,
  profile: Record<string, unknown>,
  options: { agentDir?: string; order?: boolean } = {},
): Promise<string> {
  const authPath = path.join(options.agentDir ?? state.agentDir(), "auth-profiles.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({
      version: 1,
      profiles: { "my-key": { type: "api_key", provider: "my-provider", ...profile } },
      ...(options.order ? { order: { "my-provider": ["my-key"] } } : {}),
    })}\n`,
  );
  return authPath;
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("canonical SQLite migration for historical API-key aliases", () => {
  it.each([
    {
      name: "inline snake-case key",
      profile: { api_key: "fake-snake-case-key" },
      expected: { key: "fake-snake-case-key" },
    },
    {
      name: "snake-case SecretRef",
      profile: { api_key: secretRef },
      expected: { keyRef: secretRef },
    },
    {
      name: "canonical inline key wins over the stale alias",
      profile: { key: "fake-canonical-key", api_key: "fake-stale-key" },
      expected: { key: "fake-canonical-key" },
    },
    {
      name: "canonical keyRef wins over the stale alias",
      profile: { keyRef: secretRef, api_key: "fake-stale-key" },
      expected: { keyRef: secretRef },
    },
    {
      name: "canonical inline SecretRef wins over the stale alias",
      profile: { key: secretRef, api_key: "fake-stale-key" },
      expected: { keyRef: secretRef },
    },
  ])("preserves $name and archives untouched source bytes", async ({ profile, expected }) => {
    const state = await makeTestState();
    const authPath = await writeProfiles(state, profile, { order: true });
    const original = fs.readFileSync(authPath);
    const prompter = { confirmAutoFix: vi.fn(async () => true) };

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter,
      env: state.env,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.warnings).toEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: { "my-key": { type: "api_key", provider: "my-provider", ...expected } },
      order: { "my-provider": ["my-key"] },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    const archive = fs
      .readdirSync(path.dirname(authPath))
      .find((entry) => entry.startsWith(`${path.basename(authPath)}.migrated-`));
    expect(archive).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(authPath), archive!))).toEqual(original);

    const rerun = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter,
      env: state.env,
    });
    expect(rerun).toEqual({ detected: [], changes: [], warnings: [] });
    expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
  });

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "migrates aliases from the shipped %s agent override",
    async (agentDirVariable) => {
      const state = await makeTestState();
      const agentDir = state.path(`external-${agentDirVariable.toLowerCase()}`);
      const authPath = await writeProfiles(state, { api_key: "fake-external-key" }, { agentDir });

      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg: {},
        prompter: { confirmAutoFix: async () => true },
        env: { ...state.env, [agentDirVariable]: agentDir },
      });

      expect(result.detected).toEqual([authPath]);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["my-key"]).toMatchObject({
        key: "fake-external-key",
      });
      expect(fs.existsSync(authPath)).toBe(false);
    },
  );

  it("leaves original credentials untouched when interactive repair is declined", async () => {
    const state = await makeTestState();
    const authPath = await writeProfiles(state, { api_key: "fake-declined-key" });
    const original = fs.readFileSync(authPath);

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: { confirmAutoFix: async () => false },
      env: state.env,
    });

    expect(result).toEqual({ detected: [authPath], changes: [], warnings: [] });
    expect(fs.readFileSync(authPath)).toEqual(original);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
  });
});
