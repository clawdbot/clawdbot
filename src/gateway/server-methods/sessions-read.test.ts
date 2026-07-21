import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { testState } from "../test-helpers.js";
import {
  getGatewayConfigModule,
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayRequestContext } from "./types.js";

setupGatewaySessionsTestHarness();

const UNKNOWN_AGENT_ID = "ghost";
const UNKNOWN_SESSION_KEY = `agent:${UNKNOWN_AGENT_ID}:zzz`;

function requireStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  return stateDir;
}

function expectAgentStoreAbsent(agentId: string): void {
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    agentId,
  );
}

async function listAgentIdsViaRpc(includeSystem = false): Promise<string[]> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  let ids: string[] | undefined;
  await agentsHandlers["agents.list"]?.({
    req: {} as never,
    params: {},
    respond: (ok, payload) => {
      if (ok) {
        ids = (payload as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id);
      }
    },
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
    } as unknown as GatewayRequestContext,
    client: includeSystem
      ? ({ connect: { caps: [GATEWAY_CLIENT_CAPS.AGENT_KIND] } } as never)
      : null,
    isWebchatConnect: () => false,
  });
  return ids ?? [];
}

async function setAgentsConfig(agentsConfig: Record<string, unknown> | undefined): Promise<void> {
  testState.agentsConfig = agentsConfig;
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

test("agents.list includes system rows only when negotiated", async () => {
  fs.mkdirSync(path.join(requireStateDir(), "agents", "openclaw"), { recursive: true });

  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
  expect(await listAgentIdsViaRpc(true)).toEqual(["main", "openclaw"]);
});

beforeEach(async () => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  await setAgentsConfig(undefined);
});

afterEach(() => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function configureFixedSessionStore(label = "default"): Promise<string> {
  const storePath = path.join(requireStateDir(), `shared-sessions-${label}`, "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.sessionStorePath = storePath;
  await setAgentsConfig({ list: [{ id: "main", default: true }] });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  expect(getRuntimeConfig().session?.store).toBe(storePath);
  return storePath;
}

test("unknown-agent session reads return missing results without provisioning an agent", async () => {
  const described = await directSessionReq<{ session: unknown }>("sessions.describe", {
    key: UNKNOWN_SESSION_KEY,
  });
  expect(described).toMatchObject({ ok: true, payload: { session: null } });

  const messages = await directSessionReq<{ messages: unknown[] }>("sessions.get", {
    key: UNKNOWN_SESSION_KEY,
  });
  expect(messages).toMatchObject({ ok: true, payload: { messages: [] } });

  const preview = await directSessionReq<{
    previews: Array<{ key: string; status: string; items: unknown[] }>;
  }>("sessions.preview", { keys: [UNKNOWN_SESSION_KEY] });
  expect(preview.payload?.previews).toEqual([
    { key: UNKNOWN_SESSION_KEY, status: "missing", items: [] },
  ]);

  const searched = await directSessionReq<{ results: unknown[] }>("sessions.search", {
    query: "ghost",
    sessionKeys: [UNKNOWN_SESSION_KEY],
  });
  expect(searched).toMatchObject({ ok: true, payload: { results: [] } });

  expectAgentStoreAbsent(UNKNOWN_AGENT_ID);
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
});

test("sessions.describe reads a pre-existing store after its agent is removed from config", async () => {
  const storePath = path.join(
    requireStateDir(),
    "agents",
    UNKNOWN_AGENT_ID,
    "sessions",
    "sessions.json",
  );
  await replaceSessionEntry(
    {
      agentId: UNKNOWN_AGENT_ID,
      sessionKey: UNKNOWN_SESSION_KEY,
      storePath,
    },
    { sessionId: "session-ghost", updatedAt: 42 },
  );
  await setAgentsConfig({ list: [{ id: "main", default: true }] });
  const registeredBefore = listOpenClawRegisteredAgentDatabases({
    env: { OPENCLAW_STATE_DIR: requireStateDir() },
  });

  const described = await directSessionReq<{ session: { key: string; sessionId: string } | null }>(
    "sessions.describe",
    { key: UNKNOWN_SESSION_KEY },
  );

  expect(described).toMatchObject({
    ok: true,
    payload: { session: { key: UNKNOWN_SESSION_KEY, sessionId: "session-ghost" } },
  });
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
  expect(
    listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: requireStateDir() },
    }),
  ).toEqual(registeredBefore);
});

test("sessions.describe does not treat a fixed store file as proof an unknown agent exists", async () => {
  const storePath = await configureFixedSessionStore();
  const described = await directSessionReq<{ session: unknown }>("sessions.describe", {
    key: UNKNOWN_SESSION_KEY,
  });

  expect(described).toMatchObject({ ok: true, payload: { session: null } });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: UNKNOWN_AGENT_ID,
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
});

test("sessions.describe reads an unconfigured agent with rows in a fixed store", async () => {
  const storePath = await configureFixedSessionStore();
  await replaceSessionEntry(
    { agentId: UNKNOWN_AGENT_ID, sessionKey: UNKNOWN_SESSION_KEY, storePath },
    { sessionId: "session-ghost-fixed", updatedAt: 42 },
  );

  const described = await directSessionReq<{ session: { sessionId: string } | null }>(
    "sessions.describe",
    { key: UNKNOWN_SESSION_KEY },
  );

  expect(described).toMatchObject({
    ok: true,
    payload: { session: { sessionId: "session-ghost-fixed" } },
  });
});

test.each([
  { name: "unknown first", keys: [UNKNOWN_SESSION_KEY, "agent:main:preview-valid"] },
  { name: "valid first", keys: ["agent:main:preview-valid", UNKNOWN_SESSION_KEY] },
])(
  "sessions.preview keeps fixed-store cache entries agent-distinct with $name",
  async ({ keys }) => {
    const storePath = await configureFixedSessionStore("preview-order");
    const validSessionKey = "agent:main:preview-valid";
    const validSessionId = "session-main-preview-valid";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: validSessionKey, storePath },
      { sessionId: validSessionId, updatedAt: 42 },
    );
    await seedLinearSessionTranscript({
      agentId: "main",
      contents: ["fixed store preview"],
      sessionId: validSessionId,
      sessionKey: validSessionKey,
      storePath,
    });

    const preview = await directSessionReq<{
      previews: Array<{ key: string; status: string; items: unknown[] }>;
    }>("sessions.preview", { keys });

    expect(preview.payload?.previews).toEqual(
      keys.map((key) =>
        key === UNKNOWN_SESSION_KEY
          ? { key, status: "missing", items: [] }
          : { key, status: "ok", items: expect.any(Array) },
      ),
    );
    expect(
      preview.payload?.previews.find((entry) => entry.key === validSessionKey)?.items,
    ).not.toEqual([]);
  },
);

test("sessions.describe reads an unconfigured agent from a fixed legacy store", async () => {
  const storePath = await configureFixedSessionStore("legacy");
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [UNKNOWN_SESSION_KEY]: { sessionId: "session-ghost-legacy", updatedAt: 42 },
    }),
    "utf8",
  );

  const described = await directSessionReq<{ session: { sessionId: string } | null }>(
    "sessions.describe",
    { key: UNKNOWN_SESSION_KEY },
  );

  expect(described).toMatchObject({
    ok: true,
    payload: { session: { sessionId: "session-ghost-legacy" } },
  });
});

test("sessions.search searches a retired per-agent store without explicit session keys", async () => {
  const agentId = "retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-retired-search";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  await seedLinearSessionTranscript({
    agentId,
    contents: ["retired search needle"],
    sessionId,
    sessionKey,
    storePath,
  });
  await setAgentsConfig({ list: [{ id: "main", default: true }] });

  const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
    "sessions.search",
    { agentId, query: "retired search needle" },
  );

  expect(searched.payload?.results).toEqual([expect.objectContaining({ sessionKey })]);
});

test("session reads find a retired store only reachable through its deterministic template", async () => {
  const agentId = "template-retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-template-retired";
  const storeTemplate = path.join(
    requireStateDir(),
    "external-session-stores",
    "sessions-{agentId}.json",
  );
  const storePath = storeTemplate.replace("{agentId}", agentId);
  testState.sessionStorePath = storeTemplate;
  await setAgentsConfig({ list: [{ id: "main", default: true }] });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  expect(getRuntimeConfig().session?.store).toBe(storeTemplate);
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  await seedLinearSessionTranscript({
    agentId,
    contents: ["deterministic template search needle"],
    sessionId,
    sessionKey,
    storePath,
  });

  const described = await directSessionReq<{ session: { sessionId: string } | null }>(
    "sessions.describe",
    { key: sessionKey },
  );
  const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
    "sessions.search",
    { agentId, query: "deterministic template search needle" },
  );

  expect(described).toMatchObject({
    ok: true,
    payload: { session: { sessionId } },
  });
  expect(searched.payload?.results).toEqual([expect.objectContaining({ sessionKey })]);
  expect(await listAgentIdsViaRpc()).toEqual(["main"]);
});

test("session reads still open stores for the default and configured agents", async () => {
  await setAgentsConfig({ list: [{ id: "main", default: true }, { id: "work" }] });
  for (const agentId of ["main", "work"]) {
    const result = await directSessionReq<{ session: unknown }>("sessions.describe", {
      key: `agent:${agentId}:missing`,
    });
    expect(result).toMatchObject({ ok: true, payload: { session: null } });
    expect(
      fs.existsSync(
        resolveOpenClawAgentSqlitePath({
          agentId,
          env: { OPENCLAW_STATE_DIR: requireStateDir() },
        }),
      ),
    ).toBe(true);
  }

  expect(
    listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: requireStateDir() },
    }).map((entry) => entry.agentId),
  ).toEqual(expect.arrayContaining(["main", "work"]));
});
