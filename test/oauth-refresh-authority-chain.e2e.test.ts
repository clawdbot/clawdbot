import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../src/agents/auth-profiles/oauth-refresh-marker.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../src/agents/auth-profiles/persisted.js";
import { writePersistedAuthProfileStoreRaw } from "../src/agents/auth-profiles/sqlite.js";
import type { AuthProfileStore, OAuthCredential } from "../src/agents/auth-profiles/types.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../src/state/openclaw-state-db.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PROVIDER_ID = "authority-proof";
const OWNER_MODEL_ID = "authority-owner";
const PEER_MODEL_ID = "authority-peer";
const OWNER_MODEL_REF = `${PROVIDER_ID}/${OWNER_MODEL_ID}`;
const PEER_MODEL_REF = `${PROVIDER_ID}/${PEER_MODEL_ID}`;
const PROFILE_ID = `${PROVIDER_ID}:default`;
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const ACCESS_A_OLD = "access-a-old";
const ACCESS_A_ROTATED = "access-a-rotated";
const ACCESS_B = "access-b";
const REFRESH_A = "refresh-a";
const REFRESH_A_ROTATED = "refresh-a-rotated";
const REFRESH_B = "refresh-b";
const SAME_OWNER_MARKER = "AUTHORITY-SAME-OWNER";
const SAME_PEER_MARKER = "AUTHORITY-SAME-PEER";
const SAME_RESTART_MARKER = "AUTHORITY-SAME-RESTART";
const MISMATCH_OWNER_MARKER = "AUTHORITY-MISMATCH-OWNER";
const MISMATCH_PEER_MARKER = "AUTHORITY-MISMATCH-PEER";
const LOGOUT_OWNER_MARKER = "AUTHORITY-LOGOUT-OWNER";
const LOGOUT_FOLLOWUP_MARKER = "AUTHORITY-LOGOUT-FOLLOWUP";
const REQUEST_MARKERS = [
  SAME_OWNER_MARKER,
  SAME_PEER_MARKER,
  SAME_RESTART_MARKER,
  MISMATCH_OWNER_MARKER,
  MISMATCH_PEER_MARKER,
  LOGOUT_OWNER_MARKER,
  LOGOUT_FOLLOWUP_MARKER,
] as const;

type TokenClass = "A" | "B" | "other";
type ModelAuthClass = "A" | "A-stale" | "B" | "missing" | "other";
type ProviderRequest = {
  marker: string;
  auth: ModelAuthClass;
  model: string | undefined;
};
type AgentResult = {
  runId?: string;
  status?: string;
  error?: string;
};
type TurnHandle = {
  runId: string;
  sessionKey: string;
  terminal: Promise<AgentResult>;
};
type ControlledProvider = {
  baseUrl: string;
  modelRequests: ProviderRequest[];
  refreshStarted: Promise<void>;
  releaseRefresh: () => void;
  stop: () => Promise<void>;
  tokenRequests: TokenClass[];
};
type Scenario = {
  instance: OpenClawTestInstance;
  pluginRoot: string;
  provider: ControlledProvider;
};

const activeScenarios: Scenario[] = [];
const activeClients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];

afterEach(async () => {
  for (const scenario of activeScenarios) {
    scenario.provider.releaseRefresh();
  }
  await Promise.allSettled(
    activeClients.splice(0).map((client) => disconnectGatewayClient(client)),
  );
  for (const scenario of activeScenarios.splice(0).toReversed()) {
    await scenario.instance.cleanup();
    await scenario.provider.stop();
    await fs.rm(scenario.pluginRoot, { recursive: true, force: true });
    closeOpenClawAgentDatabasesForTest(scenario.instance.stateDir);
    closeOpenClawStateDatabaseForTest();
  }
});

function oauthCredential(params: {
  accountId: string;
  access: string;
  refresh: string;
  expires: number;
}): OAuthCredential {
  return {
    type: "oauth",
    provider: PROVIDER_ID,
    accountId: params.accountId,
    access: params.access,
    refresh: params.refresh,
    expires: params.expires,
  };
}

function authStore(credential?: OAuthCredential): AuthProfileStore {
  return {
    version: 1,
    profiles: credential ? { [PROFILE_ID]: credential } : {},
    order: { [PROVIDER_ID]: [PROFILE_ID] },
  };
}

function classifyRefresh(value: unknown): TokenClass {
  if (value === REFRESH_A) {
    return "A";
  }
  if (value === REFRESH_B) {
    return "B";
  }
  return "other";
}

function classifyAuthorization(value: string | undefined): ModelAuthClass {
  if (value === `Bearer ${ACCESS_A_ROTATED}`) {
    return "A";
  }
  if (value === `Bearer ${ACCESS_A_OLD}`) {
    return "A-stale";
  }
  if (value === `Bearer ${ACCESS_B}`) {
    return "B";
  }
  if (!value) {
    return "missing";
  }
  return "other";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requestMarker(body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body);
  return REQUEST_MARKERS.find((marker) => serialized.includes(marker)) ?? "unknown";
}

async function startControlledProvider(): Promise<ControlledProvider> {
  let releaseRefresh: (() => void) | undefined;
  let markRefreshStarted: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  const tokenRequests: TokenClass[] = [];
  const modelRequests: ProviderRequest[] = [];
  let modelResponseIndex = 0;

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "POST" && request.url === "/oauth/token") {
        const body = await readJsonBody(request);
        tokenRequests.push(classifyRefresh(body.refresh));
        markRefreshStarted?.();
        await refreshGate;
        if (body.refresh !== REFRESH_A) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_refresh_generation" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access: ACCESS_A_ROTATED,
            refresh: REFRESH_A_ROTATED,
            expires: Date.now() + 60 * 60 * 1000,
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              { id: OWNER_MODEL_ID, object: "model" },
              { id: PEER_MODEL_ID, object: "model" },
            ],
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        const body = await readJsonBody(request);
        modelRequests.push({
          marker: requestMarker(body),
          auth: classifyAuthorization(request.headers.authorization),
          model: typeof body.model === "string" ? body.model : undefined,
        });
        modelResponseIndex += 1;
        writeOpenAiResponsesText(response, {
          text: `authority proof response ${modelResponseIndex}`,
          messageId: `authority-message-${modelResponseIndex}`,
          responseId: `authority-response-${modelResponseIndex}`,
        });
        return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("authority proof provider did not bind a loopback port");
  }
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    modelRequests,
    refreshStarted,
    releaseRefresh: () => releaseRefresh?.(),
    tokenRequests,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      releaseRefresh?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function writeProviderPlugin(pluginDir: string, tokenUrl: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PROVIDER_ID,
        activation: { onStartup: true, onProviders: [PROVIDER_ID] },
        providers: [PROVIDER_ID],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    [
      "export default {",
      `  id: ${JSON.stringify(PROVIDER_ID)},`,
      "  register(api) {",
      "    api.registerProvider({",
      `      id: ${JSON.stringify(PROVIDER_ID)},`,
      '      label: "OAuth authority proof",',
      "      auth: [],",
      "      async refreshOAuth(credential) {",
      `        const response = await fetch(${JSON.stringify(tokenUrl)}, {`,
      '          method: "POST",',
      '          headers: { "content-type": "application/json" },',
      "          body: JSON.stringify({ refresh: credential.refresh }),",
      "        });",
      '        if (!response.ok) throw new Error("authority proof refresh rejected");',
      "        const refreshed = await response.json();",
      "        return {",
      "          ...credential,",
      '          type: "oauth",',
      `          provider: ${JSON.stringify(PROVIDER_ID)},`,
      "          access: refreshed.access,",
      "          refresh: refreshed.refresh,",
      "          expires: refreshed.expires,",
      "        };",
      "      },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

function createConfig(pluginDir: string, providerBaseUrl: string) {
  return {
    plugins: {
      enabled: true,
      allow: [PROVIDER_ID],
      load: { paths: [pluginDir] },
      entries: { [PROVIDER_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
    agents: {
      defaults: {
        model: { primary: OWNER_MODEL_REF, fallbacks: [] },
        models: {
          [OWNER_MODEL_REF]: { agentRuntime: { id: "openclaw" } },
          [PEER_MODEL_REF]: { agentRuntime: { id: "openclaw" } },
        },
        workspace: "~/workspace",
        skills: [],
        skipBootstrap: true,
        sandbox: { mode: "off" },
        timeoutSeconds: 60,
      },
      list: [
        { id: "owner", default: true, model: OWNER_MODEL_REF },
        { id: "peer", model: PEER_MODEL_REF },
      ],
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `${providerBaseUrl}/v1`,
          api: "openai-responses",
          auth: "oauth",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: OWNER_MODEL_ID,
              name: OWNER_MODEL_ID,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2_048,
            },
            {
              id: PEER_MODEL_ID,
              name: PEER_MODEL_ID,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2_048,
            },
          ],
        },
      },
    },
  };
}

async function createScenario(name: string): Promise<Scenario> {
  const provider = await startControlledProvider();
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-authority-plugin-"));
  const pluginDir = path.join(pluginRoot, "plugin");
  try {
    await writeProviderPlugin(pluginDir, `${provider.baseUrl}/oauth/token`);
    const instance = await createOpenClawTestInstance({
      name,
      config: createConfig(pluginDir, provider.baseUrl),
      env: {
        OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    const scenario = { instance, pluginRoot, provider };
    activeScenarios.push(scenario);
    return scenario;
  } catch (error) {
    provider.releaseRefresh();
    await provider.stop();
    await fs.rm(pluginRoot, { recursive: true, force: true });
    throw error;
  }
}

function writeSharedStore(instance: OpenClawTestInstance, store: AuthProfileStore): void {
  runOpenClawStateWriteTransaction(
    (database) => writePersistedAuthProfileStoreRaw(store, undefined, database),
    { env: instance.env },
  );
}

async function seedScenario(params: {
  instance: OpenClawTestInstance;
  shared?: OAuthCredential;
  owner: OAuthCredential;
  peer: OAuthCredential;
}): Promise<void> {
  if (params.shared) {
    writeSharedStore(params.instance, authStore(params.shared));
  }
  await params.instance.state.writeAuthProfiles(authStore(params.owner), "owner");
  await params.instance.state.writeAuthProfiles(authStore(params.peer), "peer");
  closeOpenClawAgentDatabasesForTest(params.instance.stateDir);
  closeOpenClawStateDatabaseForTest();
}

function readLocalCredential(
  instance: OpenClawTestInstance,
  agentId: "owner" | "peer",
): OAuthCredential | undefined {
  const credential = loadPersistedAuthProfileStore(instance.state.agentDir(agentId))?.profiles[
    PROFILE_ID
  ];
  return credential?.type === "oauth" ? credential : undefined;
}

function readSharedCredential(instance: OpenClawTestInstance): OAuthCredential | undefined {
  const credential = loadPersistedSharedAuthProfileStore(instance.env)?.profiles[PROFILE_ID];
  return credential?.type === "oauth" ? credential : undefined;
}

function expectTerminalFence(credential: OAuthCredential | undefined): void {
  expect(credential && isOAuthRefreshFence(credential)).toBe(true);
  expect(credential && isPendingOAuthRefreshFence(credential)).toBe(false);
}

function expiredAccountA(): OAuthCredential {
  return oauthCredential({
    accountId: ACCOUNT_A,
    access: ACCESS_A_OLD,
    refresh: REFRESH_A,
    expires: Date.now() - 60_000,
  });
}

function expectAuthError(result: AgentResult, message: string): void {
  expect(result).toMatchObject({
    status: "error",
    error: expect.stringContaining(message),
  });
}

async function connect(instance: OpenClawTestInstance) {
  const client = await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  activeClients.push(client);
  return client;
}

async function startTurn(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  agentId: "owner" | "peer";
  marker: string;
  runId: string;
}): Promise<TurnHandle> {
  const sessionKey = `agent:${params.agentId}:authority-proof:${params.runId}`;
  const started = await params.client.request<AgentResult>("agent", {
    sessionKey,
    message: `Reply exactly ${params.marker}.`,
    deliver: false,
    idempotencyKey: params.runId,
  });
  const runId = started.runId ?? params.runId;
  if (started.status === "ok") {
    return { runId, sessionKey, terminal: Promise.resolve(started) };
  }
  expect(started).toMatchObject({ status: "accepted", runId });
  const terminal = params.client.request<AgentResult>(
    "agent.wait",
    { runId, timeoutMs: REQUEST_TIMEOUT_MS },
    { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
  );
  void terminal.catch(() => undefined);
  return { runId, sessionKey, terminal };
}

async function executionPhaseBaseline(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
): Promise<number> {
  const snapshot = await client.request<{ lastSeq?: number }>("diagnostics.stability", {
    type: "run.execution_phase",
    limit: 1,
  });
  return snapshot.lastSeq ?? 0;
}

async function waitForExecutionPhaseSince(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  sinceSeq: number;
  model: string;
  phase: string;
}): Promise<void> {
  await vi.waitFor(
    async () => {
      const snapshot = await params.client.request<{
        events?: Array<{ model?: string; phase?: string }>;
      }>("diagnostics.stability", {
        type: "run.execution_phase",
        sinceSeq: params.sinceSeq,
        limit: 200,
      });
      expect(snapshot.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: params.model, phase: params.phase }),
        ]),
      );
    },
    { interval: 20, timeout: REQUEST_TIMEOUT_MS },
  );
}

async function expectTurnPending(params: {
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  turn: TurnHandle;
}): Promise<void> {
  const result = await params.client.request<AgentResult>(
    "agent.wait",
    { runId: params.turn.runId, timeoutMs: 0 },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  expect(result).toEqual({ runId: params.turn.runId, status: "timeout" });
}

function emitEvidence(scenario: string, evidence: Record<string, unknown>): void {
  console.log(`[oauth-refresh-authority-chain] ${JSON.stringify({ scenario, ...evidence })}`);
}

describe("OAuth refresh authority chain", () => {
  it(
    "makes a pending peer wait and inherit only the same-account shared rotation",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scenario = await createScenario("oauth-authority-same-account");
      const expiredA = expiredAccountA();
      await seedScenario({
        instance: scenario.instance,
        shared: expiredA,
        owner: expiredA,
        peer: expiredA,
      });
      await scenario.instance.startGateway();
      let client = await connect(scenario.instance);

      const owner = await startTurn({
        client,
        agentId: "owner",
        marker: SAME_OWNER_MARKER,
        runId: "authority-same-owner",
      });
      await scenario.provider.refreshStarted;

      const peerPhaseBaseline = await executionPhaseBaseline(client);
      const peer = await startTurn({
        client,
        agentId: "peer",
        marker: SAME_PEER_MARKER,
        runId: "authority-same-peer",
      });
      await waitForExecutionPhaseSince({
        client,
        sinceSeq: peerPhaseBaseline,
        model: PEER_MODEL_ID,
        phase: "model_resolution",
      });
      await expectTurnPending({ client, turn: peer });
      expect(scenario.provider.tokenRequests).toEqual(["A"]);
      expect(scenario.provider.modelRequests).toHaveLength(0);

      scenario.provider.releaseRefresh();
      await expect(owner.terminal).resolves.toMatchObject({ status: "ok" });
      await expect(peer.terminal).resolves.toMatchObject({ status: "ok" });
      await vi.waitFor(() => expect(scenario.provider.modelRequests).toHaveLength(2), {
        interval: 20,
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(
        scenario.provider.modelRequests.toSorted((left, right) =>
          left.marker.localeCompare(right.marker),
        ),
      ).toEqual([
        { marker: SAME_OWNER_MARKER, auth: "A", model: OWNER_MODEL_ID },
        { marker: SAME_PEER_MARKER, auth: "A", model: PEER_MODEL_ID },
      ]);
      expect(readLocalCredential(scenario.instance, "peer")).toBeUndefined();
      expect(readSharedCredential(scenario.instance)).toMatchObject({
        accountId: ACCOUNT_A,
        access: ACCESS_A_ROTATED,
        refresh: REFRESH_A_ROTATED,
      });

      await disconnectGatewayClient(client);
      const clientIndex = activeClients.indexOf(client);
      if (clientIndex >= 0) {
        activeClients.splice(clientIndex, 1);
      }
      await scenario.instance.stopGateway();
      await scenario.instance.startGateway();
      client = await connect(scenario.instance);
      const restartRequestOffset = scenario.provider.modelRequests.length;
      const restarted = await startTurn({
        client,
        agentId: "peer",
        marker: SAME_RESTART_MARKER,
        runId: "authority-same-restart",
      });
      await expect(restarted.terminal).resolves.toMatchObject({ status: "ok" });
      expect(scenario.provider.modelRequests.slice(restartRequestOffset)).toEqual([
        {
          marker: SAME_RESTART_MARKER,
          auth: "A",
          model: PEER_MODEL_ID,
        },
      ]);
      expect(scenario.provider.tokenRequests).toEqual(["A"]);

      emitEvidence("same-account", {
        refreshRequests: scenario.provider.tokenRequests,
        modelRequests: scenario.provider.modelRequests,
        peerWaitedForSettlement: true,
        peerInheritedSharedCredential: readLocalCredential(scenario.instance, "peer") === undefined,
        sharedAccount: readSharedCredential(scenario.instance)?.accountId,
        restartedGatewayUsedAccount: scenario.provider.modelRequests.at(-1)?.auth,
      });
    },
  );

  it(
    "terminally fences a peer when the authoritative shared account differs",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scenario = await createScenario("oauth-authority-account-mismatch");
      const expiredA = expiredAccountA();
      const usableB = oauthCredential({
        accountId: ACCOUNT_B,
        access: ACCESS_B,
        refresh: REFRESH_B,
        expires: Date.now() + 60 * 60 * 1000,
      });
      await seedScenario({
        instance: scenario.instance,
        shared: usableB,
        owner: expiredA,
        peer: expiredA,
      });
      await scenario.instance.startGateway();
      const client = await connect(scenario.instance);

      const owner = await startTurn({
        client,
        agentId: "owner",
        marker: MISMATCH_OWNER_MARKER,
        runId: "authority-mismatch-owner",
      });
      await scenario.provider.refreshStarted;
      const peerPhaseBaseline = await executionPhaseBaseline(client);
      const peer = await startTurn({
        client,
        agentId: "peer",
        marker: MISMATCH_PEER_MARKER,
        runId: "authority-mismatch-peer",
      });
      await waitForExecutionPhaseSince({
        client,
        sinceSeq: peerPhaseBaseline,
        model: PEER_MODEL_ID,
        phase: "model_resolution",
      });
      await expectTurnPending({ client, turn: peer });
      expect(scenario.provider.tokenRequests).toEqual(["A"]);
      expect(scenario.provider.modelRequests).toHaveLength(0);

      scenario.provider.releaseRefresh();
      await expect(owner.terminal).resolves.toMatchObject({ status: "ok" });
      const peerTerminal = await peer.terminal;
      expectAuthError(peerTerminal, `No credentials found for profile "${PROFILE_ID}".`);
      await vi.waitFor(() => expect(scenario.provider.modelRequests).toHaveLength(1), {
        interval: 20,
        timeout: REQUEST_TIMEOUT_MS,
      });
      expect(scenario.provider.modelRequests).toEqual([
        { marker: MISMATCH_OWNER_MARKER, auth: "A", model: OWNER_MODEL_ID },
      ]);
      expect(readLocalCredential(scenario.instance, "owner")).toMatchObject({
        accountId: ACCOUNT_A,
        access: ACCESS_A_ROTATED,
      });
      expectTerminalFence(readLocalCredential(scenario.instance, "peer"));
      expect(readLocalCredential(scenario.instance, "peer")).not.toMatchObject({
        access: ACCESS_A_ROTATED,
      });
      expect(readSharedCredential(scenario.instance)).toMatchObject({
        accountId: ACCOUNT_B,
        access: ACCESS_B,
        refresh: REFRESH_B,
      });

      emitEvidence("account-mismatch", {
        refreshRequests: scenario.provider.tokenRequests,
        modelRequests: scenario.provider.modelRequests,
        ownerAccount: readLocalCredential(scenario.instance, "owner")?.accountId,
        peerTerminalStatus: peerTerminal.status,
        peerTerminalFence: true,
        sharedAccount: readSharedCredential(scenario.instance)?.accountId,
      });
    },
  );

  it(
    "lets real logout revoke a held generation before stale refresh settlement",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const scenario = await createScenario("oauth-authority-logout");
      const expiredA = expiredAccountA();
      await seedScenario({
        instance: scenario.instance,
        owner: expiredA,
        peer: expiredA,
      });
      await scenario.instance.startGateway();
      const client = await connect(scenario.instance);

      const owner = await startTurn({
        client,
        agentId: "owner",
        marker: LOGOUT_OWNER_MARKER,
        runId: "authority-logout-owner",
      });
      await scenario.provider.refreshStarted;

      const logout = await scenario.instance.cli(
        ["models", "auth", "logout", PROFILE_ID, "--agent", "owner", "--yes"],
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      expect(logout.code, logout.stderr).toBe(0);
      expect(logout.stdout).toContain(`Removed auth profile: ${PROFILE_ID}`);
      expect(readLocalCredential(scenario.instance, "owner")).toBeUndefined();
      expect(readLocalCredential(scenario.instance, "peer")).toBeUndefined();

      scenario.provider.releaseRefresh();
      const staleTerminal = await owner.terminal;
      expectAuthError(
        staleTerminal,
        `OAuth token refresh failed for ${PROVIDER_ID}: Failed to persist refreshed OAuth credential.`,
      );
      expect(scenario.provider.modelRequests).toHaveLength(0);
      expect(readLocalCredential(scenario.instance, "owner")).toBeUndefined();
      expect(readLocalCredential(scenario.instance, "peer")).toBeUndefined();
      expect(readSharedCredential(scenario.instance)).toBeUndefined();

      const followup = await startTurn({
        client,
        agentId: "owner",
        marker: LOGOUT_FOLLOWUP_MARKER,
        runId: "authority-logout-followup",
      });
      const followupTerminal = await followup.terminal;
      expectAuthError(followupTerminal, `No API key found for provider "${PROVIDER_ID}".`);
      expect(scenario.provider.modelRequests).toHaveLength(0);
      expect(scenario.provider.tokenRequests).toEqual(["A"]);
      expect(readLocalCredential(scenario.instance, "owner")).toBeUndefined();
      expect(readLocalCredential(scenario.instance, "peer")).toBeUndefined();

      emitEvidence("logout-during-refresh", {
        refreshRequests: scenario.provider.tokenRequests,
        modelRequests: scenario.provider.modelRequests,
        logoutCode: logout.code,
        staleTurnStatus: staleTerminal.status,
        followupStatus: followupTerminal.status,
        ownerProfilePresent: readLocalCredential(scenario.instance, "owner") !== undefined,
        peerProfilePresent: readLocalCredential(scenario.instance, "peer") !== undefined,
        sharedProfilePresent: readSharedCredential(scenario.instance) !== undefined,
      });
    },
  );
});
