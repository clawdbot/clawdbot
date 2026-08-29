import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { AgentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore as resolveStorePath } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordAgentProvenance } from "../../state/agent-provenance.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { testState } from "../test-helpers.js";
import {
  getGatewayConfigModule,
  directSessionReq,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

setupGatewaySessionsHandlerTestHarness();

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

async function listAgentsViaRpc(
  includeSystem = false,
  catalogContext: Partial<GatewayRequestContext> = {},
): Promise<AgentsListResult> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  let result: AgentsListResult | undefined;
  await agentsHandlers["agents.list"]?.({
    req: {} as never,
    params: {},
    respond: (ok, payload) => {
      if (ok) {
        result = payload as AgentsListResult;
      }
    },
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      readPreparedGatewayModelCatalog: async () => ({ entries: [] }),
      ...catalogContext,
    } as unknown as GatewayRequestContext,
    client: includeSystem
      ? ({ connect: { caps: [GATEWAY_CLIENT_CAPS.AGENT_KIND] } } as never)
      : null,
    isWebchatConnect: () => false,
  });
  if (!result) {
    throw new Error("agents.list did not return a result");
  }
  return result;
}

async function listAgentIdsViaRpc(
  includeSystem = false,
  catalogContext: Partial<GatewayRequestContext> = {},
): Promise<string[]> {
  const result = await listAgentsViaRpc(includeSystem, catalogContext);
  return result.agents.map((agent) => agent.id);
}

async function setAgentsConfig(agentsConfig: Record<string, unknown> | undefined): Promise<void> {
  testState.agentsConfig = agentsConfig;
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

test("agents.list includes system rows only when negotiated", async () => {
  fs.mkdirSync(path.join(requireStateDir(), "agents", "openclaw"), { recursive: true });
  testState.agentConfig = { model: { primary: "local/shared-reasoner" } };
  const readPreparedGatewayModelCatalog = vi.fn(async () => ({
    entries: [
      {
        id: "shared-reasoner",
        name: "Shared Reasoner",
        provider: "local",
        reasoning: false,
      },
    ],
  }));

  expect(await listAgentIdsViaRpc(false, { readPreparedGatewayModelCatalog })).toEqual(["main"]);
  const result = await listAgentsViaRpc(true, { readPreparedGatewayModelCatalog });
  expect(result.agents.map((agent) => agent.id)).toEqual(["main", "openclaw"]);
  expect(
    result.agents
      .find((agent) => agent.id === "openclaw")
      ?.thinkingLevels?.map((level) => level.id),
  ).toEqual(["off"]);
  expect(readPreparedGatewayModelCatalog.mock.calls).toEqual([
    [{ agentId: "main" }],
    [{ agentId: "main" }],
  ]);
});

test("agents.list reads published model facts without starting provider discovery", async () => {
  const loadGatewayModelCatalog = vi.fn(async () => []);
  const readPreparedGatewayModelCatalog = vi.fn(async () => ({ entries: [] }));

  await expect(
    listAgentIdsViaRpc(false, {
      loadGatewayModelCatalog,
      readPreparedGatewayModelCatalog,
    }),
  ).resolves.toEqual(["main"]);

  expect(readPreparedGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "main" });
  expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
});

test("agents.list returns the roster when optional prepared model facts are unavailable", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  const readPreparedGatewayModelCatalog = vi.fn(async () => {
    throw new Error("prepared model catalog requires an explicit owner");
  });

  await expect(listAgentIdsViaRpc(false, { readPreparedGatewayModelCatalog })).resolves.toEqual([
    "ops",
    "research",
  ]);

  expect(readPreparedGatewayModelCatalog.mock.calls).toEqual([
    [{ agentId: "ops" }],
    [{ agentId: "research" }],
  ]);
});

test.each([
  { unavailableAgentId: undefined },
  { unavailableAgentId: "work" },
  { unavailableAgentId: "main" },
])(
  "agents.list keeps prepared thinking metadata scoped to each roster agent ($unavailableAgentId unavailable)",
  async ({ unavailableAgentId }) => {
    testState.agentConfig = { model: { primary: "local/shared-reasoner" } };
    await setAgentsConfig({
      ownership: "explicit",
      entries: { main: {}, work: {} },
    });
    const readPreparedGatewayModelCatalog = vi.fn(async (options?: { agentId?: string }) => {
      if (!options?.agentId || options.agentId === unavailableAgentId) {
        return undefined;
      }
      return {
        entries: [
          {
            id: "shared-reasoner",
            name: "Shared Reasoner",
            provider: "local",
            reasoning: options.agentId === "work",
          },
        ],
      };
    });

    const result = await listAgentsViaRpc(false, { readPreparedGatewayModelCatalog });
    const main = result.agents.find((agent) => agent.id === "main");
    const work = result.agents.find((agent) => agent.id === "work");

    const mainLevels = main?.thinkingLevels?.map((level) => level.id);
    if (unavailableAgentId === "main") {
      expect(mainLevels).toContain("high");
    } else {
      expect(mainLevels).toEqual(["off"]);
    }
    expect(work?.thinkingLevels?.map((level) => level.id)).toContain("high");
    expect(readPreparedGatewayModelCatalog.mock.calls).toEqual([
      [{ agentId: "main" }],
      [{ agentId: "work" }],
    ]);
  },
);

test("agents.list includes durable provenance only for matching roster rows", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  recordAgentProvenance("research", { createdVia: "agent", creatorAgentId: "ops" }, { nowMs: 42 });

  const result = await listAgentsViaRpc();

  expect(result.agents.map((agent) => agent.id)).toEqual(["ops", "research"]);
  expect(result.agents[0]).not.toHaveProperty("createdVia");
  expect(result.agents[0]).not.toHaveProperty("creatorAgentId");
  expect(result.agents[0]).not.toHaveProperty("createdAt");
  expect(result.agents[1]).toMatchObject({
    createdVia: "agent",
    creatorAgentId: "ops",
    createdAt: 42,
  });
});

beforeEach(async () => {
  testState.agentConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  await setAgentsConfig(undefined);
});

afterEach(() => {
  testState.agentConfig = undefined;
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

test("sessions.resolve preserves presentation facts on unique and ambiguous wire results", async () => {
  const firstKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
  const secondKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  await replaceSessionEntry(
    { agentId: "main", sessionKey: firstKey, storePath },
    {
      sessionId: "first-session",
      updatedAt: 2,
      displayName: "Deploy monitor",
      boardFace: "dashboard",
    },
  );

  const unique = await directSessionReq("sessions.resolve", {
    shortId: "12345678",
    agentId: "main",
  });
  expect(unique).toMatchObject({
    ok: true,
    payload: {
      ok: true,
      key: firstKey,
      agentId: "main",
      displayName: "Deploy monitor",
      boardFace: "dashboard",
    },
  });

  await replaceSessionEntry(
    { agentId: "main", sessionKey: secondKey, storePath },
    {
      sessionId: "second-session",
      updatedAt: 1,
      displayName: "Release monitor",
      boardFace: "chat",
    },
  );
  const ambiguous = await directSessionReq("sessions.resolve", {
    shortId: "12345678",
    agentId: "main",
  });
  expect(ambiguous).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      candidates: [
        { key: firstKey, agentId: "main", displayName: "Deploy monitor", boardFace: "dashboard" },
        { key: secondKey, agentId: "main", displayName: "Release monitor", boardFace: "chat" },
      ],
    },
  });
});

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

test("a hidden-foreign role cannot discover sessions through search, batch previews, or exact resolve", async () => {
  const ownerId = ensureProfileForEmail("role-viewer@example.com").id;
  const foreignKey = "agent:main:foreign-role-read";
  const ownKey = "agent:main:own-role-read";
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  for (const [sessionKey, actorId] of [
    [foreignKey, "foreign-owner@example.com"],
    [ownKey, ownerId],
  ] as const) {
    const sessionId = `session-${sessionKey.split(":").at(-1)}`;
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: 42,
        createdActor: { type: "human", id: actorId },
        visibility: "shared",
      },
    );
    await seedLinearSessionTranscript({
      agentId: "main",
      contents: ["hidden role search needle"],
      sessionId,
      sessionKey,
      storePath,
    });
  }
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }] },
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId: ownerId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  const options = { client, context: { getRuntimeConfig: () => cfg } };

  const searched = await directSessionReq<{ results: Array<{ sessionKey: string }> }>(
    "sessions.search",
    { query: "hidden role search needle" },
    options,
  );
  expect(searched.payload?.results.map((result) => result.sessionKey)).toEqual([ownKey]);

  const previews = await directSessionReq<{
    previews: Array<{ key: string; status: string }>;
  }>("sessions.preview", { keys: [foreignKey, ownKey] }, options);
  expect(previews.payload?.previews).toMatchObject([
    { key: foreignKey, status: "missing" },
    { key: ownKey, status: "ok" },
  ]);

  const resolved = await directSessionReq("sessions.resolve", { key: foreignKey }, options);
  expect(resolved).toMatchObject({
    ok: false,
    error: { message: `No session found: ${foreignKey}` },
  });
});

test("bare ownerless reads fail closed without blocking scoped preview siblings", async () => {
  await setAgentsConfig({ ownership: "explicit", entries: { ops: {}, research: {} } });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  expect(getRuntimeConfig().agents).toMatchObject({
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  });
  const sessionKey = "agent:ops:preview-valid";
  const sessionId = "session-ops-preview-valid";
  const storePath = resolveStorePath(undefined, { agentId: "ops" });
  await replaceSessionEntry(
    { agentId: "ops", sessionKey, storePath },
    { sessionId, updatedAt: 42 },
  );
  await seedLinearSessionTranscript({
    agentId: "ops",
    contents: ["scoped preview remains readable"],
    sessionId,
    sessionKey,
    storePath,
  });

  const described = await directSessionReq<{ session: unknown }>("sessions.describe", {
    key: "global",
  });
  expect(described).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
  });

  const preview = await directSessionReq<{
    previews: Array<{ key: string; status: string; items: unknown[] }>;
  }>("sessions.preview", { keys: ["global", sessionKey] });
  expect(preview).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
  });
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

test("sessions.describe ignores an unconfigured agent found only in a fixed legacy store", async () => {
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
    payload: { session: null },
  });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: UNKNOWN_AGENT_ID,
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
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

test("session reads do not provision missing stores for default or configured agents", async () => {
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
    ).toBe(false);
  }

  expect(
    listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: requireStateDir() },
    })
      .map((entry) => entry.agentId)
      .filter((agentId) => agentId === "main" || agentId === "work"),
  ).toEqual([]);
});
