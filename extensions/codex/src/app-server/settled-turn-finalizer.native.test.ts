import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import * as authBridge from "./auth-bridge.js";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
} from "./session-binding.test-helpers.js";
import * as settledContext from "./settled-turn-context.js";
import { runCodexSettledTurnFinalization } from "./settled-turn-finalizer.js";
import * as sharedClients from "./shared-client.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

// Same native multi-agent generation keeps model-selection proof separate from migration.
const NATIVE_MODEL = "gpt-5.6-sol";
const HOST_MODEL = "gpt-5.6-terra";
const NATIVE_KEY = "synthetic-native-account";
const HOST_KEY = "synthetic-host-account";
const HOST_PROFILE = "openai:host-fixture";
const OTHER_PROFILE = "openai:other-fixture";
const SUMMARY = "The action completed once.";

type NativeFixture = Awaited<ReturnType<typeof createNativeFixture>>;
type NativeRunParams = ReturnType<typeof createNativeRunParams>;
type Cleanup = () => Promise<void>;
type NativePhase = "probe" | "action" | "summary" | "health";

async function closeNativeClient(client: CodexAppServerClient): Promise<void> {
  expect(await client.closeAndWait()).toBe(true);
}

async function createNativeFixture(cleanups: Cleanup[], failures: unknown[]) {
  const root = await fs.realpath(tempDir);
  const native = await createCodexNativeTestState(root);
  for (const [name, value] of Object.entries(native.env)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  const requests: Array<{ body: JsonObject; account: string | undefined }> = [];
  let phase: NativePhase = "probe";
  let actionRequests = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        if (request.url !== "/v1/responses" || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        const parsed: unknown = JSON.parse(body);
        if (!isJsonObject(parsed)) {
          response.writeHead(400).end();
          return;
        }
        const account = request.headers.authorization;
        requests.push({ body: parsed, account });
        if (account !== `Bearer ${NATIVE_KEY}` && account !== `Bearer ${HOST_KEY}`) {
          response.writeHead(401).end();
          return;
        }
        if (parsed.model !== NATIVE_MODEL && parsed.model !== HOST_MODEL) {
          response.writeHead(400).end();
          return;
        }
        if (phase === "action") {
          actionRequests += 1;
        }
        const item =
          phase === "action"
            ? actionRequests === 1
              ? {
                  type: "function_call",
                  call_id: "completed-action",
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "printf 'completed-once\\n' >> completed-actions.txt; cat completed-actions.txt",
                    shell: "/bin/sh",
                    login: false,
                    max_output_tokens: 1000,
                  }),
                }
              : undefined
            : {
                type: "message",
                role: "assistant",
                id: `answer-${requests.length}`,
                content: [{ type: "output_text", text: phase === "summary" ? SUMMARY : "Ready." }],
              };
        const events = [
          { type: "response.created", response: { id: `response-${requests.length}` } },
          ...(item ? [{ type: "response.output_item.done", item }] : []),
          {
            type: "response.completed",
            response: {
              id: `response-${requests.length}`,
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        ];
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end();
      }
    });
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback provider has no TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const agentDir = path.join(root, "agent");
  const authProfileStore: AuthProfileStore = {
    version: 1,
    profiles: {
      [HOST_PROFILE]: { type: "api_key", provider: "openai", key: HOST_KEY },
      [OTHER_PROFILE]: { type: "api_key", provider: "openai", key: NATIVE_KEY },
    },
  };
  const pluginConfig = {
    supervision: { enabled: true },
    appServer: {
      command: native.command,
      args: ["app-server", "-c", `openai_base_url=${JSON.stringify(baseUrl)}`],
      homeScope: "user" as const,
    },
  };
  return {
    native,
    root,
    agentDir,
    baseUrl,
    pluginConfig,
    authProfileStore,
    requests,
    marker: path.join(native.cwd, "completed-actions.txt"),
    setPhase(next: NativePhase) {
      phase = next;
      requests.length = 0;
      actionRequests = 0;
    },
  };
}

async function withNativeFixture(
  run: (fixture: NativeFixture, cleanups: Cleanup[]) => Promise<void>,
): Promise<void> {
  const cleanups: Cleanup[] = [];
  const failures: unknown[] = [];
  try {
    await run(await createNativeFixture(cleanups, failures), cleanups);
  } catch (error) {
    failures.push(error);
  } finally {
    // Join children before the shared harness afterEach removes their homes.
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Native finalization proof or cleanup failed");
  }
}

async function writeNativeConfig(
  fixture: NativeFixture,
  codexHome: string,
  provider: "openai" | "settled-fixture",
  nativeFileAuth = false,
) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model=${JSON.stringify(NATIVE_MODEL)}`,
      `model_provider=${JSON.stringify(provider)}`,
      `cli_auth_credentials_store=${JSON.stringify(nativeFileAuth ? "file" : "ephemeral")}`,
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="workspace-write"',
      "allow_login_shell=false",
      "[features]",
      "shell_snapshot=false",
      "[analytics]",
      "enabled=false",
      "[feedback]",
      "enabled=false",
      ...(provider === "settled-fixture"
        ? [
            "[model_providers.settled-fixture]",
            'name="Synthetic settled-turn provider"',
            `base_url=${JSON.stringify(fixture.baseUrl)}`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            `experimental_bearer_token=${JSON.stringify(NATIVE_KEY)}`,
            "supports_websockets=false",
            "request_max_retries=0",
            "stream_max_retries=0",
          ]
        : []),
    ].join("\n"),
  );
  if (nativeFileAuth) {
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: NATIVE_KEY }),
    );
  }
}

async function runNativePrompt(client: CodexAppServerClient, threadId: string, prompt: string) {
  const completed = createDeferred<{ id: string; status: string }>();
  void completed.promise.catch(() => undefined);
  const removeHandler = client.addNotificationHandler((notification) => {
    if (
      notification.method === "turn/completed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === threadId &&
      isJsonObject(notification.params.turn) &&
      typeof notification.params.turn.id === "string" &&
      typeof notification.params.turn.status === "string"
    ) {
      completed.resolve({
        id: notification.params.turn.id,
        status: notification.params.turn.status,
      });
    }
  });
  const timer = setTimeout(
    () => completed.reject(new Error("Native fixture turn timed out")),
    15_000,
  );
  timer.unref?.();
  try {
    await client.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] },
      { timeoutMs: 15_000 },
    );
    const turn = await completed.promise;
    expect(turn.status).toBe("completed");
    return turn.id;
  } finally {
    clearTimeout(timer);
    removeHandler();
  }
}

async function createRunParams(fixture: NativeFixture) {
  const params = createNativeRunParams(
    path.join(fixture.root, "session.jsonl"),
    fixture.native.cwd,
  );
  await attachSqliteSessionTarget(
    params,
    path.join(fixture.root, "transcript.sqlite"),
    "settled-native",
  );
  params.agentDir = fixture.agentDir;
  params.prompt = "Record the completed action once.";
  params.provider = "openai";
  params.modelId = NATIVE_MODEL;
  params.model = { ...params.model, id: NATIVE_MODEL, provider: "openai", api: "openai-responses" };
  params.authProfileId = HOST_PROFILE;
  params.authProfileStore = fixture.authProfileStore;
  params.resolvedApiKey = HOST_KEY;
  params.disableTools = false;
  params.permissionMode = "full";
  params.timeoutMs = 20_000;
  params.config = { tools: { web: { search: { enabled: false } } } };
  dynamicToolBuildState.openClawCodingToolsFactory = () => [];
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  return params;
}

function usePreparedApiKey(params: NativeRunParams, baseUrl: string) {
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: params.modelId,
        api: "openai-responses",
        baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
  };
}

function transcriptTarget(params: NativeRunParams) {
  return {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath: params.sessionTarget!.storePath,
  };
}

function trackSharedClient(cleanups: Cleanup[]) {
  let current: CodexAppServerClient | undefined;
  const factory: CodexAppServerClientFactory = async (options) => {
    const client = await sharedClients.getLeasedSharedCodexAppServerClient(options);
    if (client !== current) {
      cleanups.push(async () => {
        await sharedClients.clearSharedCodexAppServerClientIfCurrentAndWait(client);
        await closeNativeClient(client);
      });
      current = client;
    }
    return client;
  };
  return {
    factory,
    client() {
      if (!current) {
        throw new Error("The native attempt did not acquire its shared client");
      }
      return current;
    },
  };
}

// Admission and binding seeding are fixtures, not Gateway/catalog or live OAuth
// proof. Native execution, host auth, settlement, and transcript writes are real;
// every model HTTP response comes from the isolated loopback provider.
// This fixture executes /bin/sh; the owner-boundary unit tests are platform-independent.
describe.skipIf(process.platform === "win32")(
  "stock Codex settled-turn finalization ownership",
  () => {
    it(
      "refuses supervised finalization even when different host credentials and model work",
      { timeout: 60_000 },
      async () => {
        await withNativeFixture(async (fixture, cleanups) => {
          const { native, pluginConfig, agentDir, requests, authProfileStore } = fixture;
          await writeNativeConfig(fixture, native.codexHome, "settled-fixture");
          // A successful private turn makes wrong-account fallback an available path,
          // rather than letting this regression pass only because host auth is broken.
          const hostProbe = await runBoundedCodexAppServerTurn({
            model: { mode: "required", id: HOST_MODEL },
            profile: HOST_PROFILE,
            authProfileStore,
            agentDir,
            timeoutMs: 15_000,
            options: { pluginConfig },
            taskLabel: "host auth proof",
            developerInstructions: "Reply Ready.",
            input: [{ type: "text", text: "Verify the host account.", text_elements: [] }],
            requiredModalities: ["text"],
            isolation: "private-stdio",
            requireNoExternalCapabilities: true,
          });
          expect(hostProbe.text).toBe("Ready.");
          expect(requests.map(({ body, account }) => ({ model: body.model, account }))).toEqual([
            { model: HOST_MODEL, account: `Bearer ${HOST_KEY}` },
          ]);
          fixture.setPhase("probe");
          const appServer = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig });
          const sourceClient = await sharedClients.createIsolatedCodexAppServerClient({
            startOptions: appServer.start,
            authProfileId: null,
            agentDir,
            config: {},
            timeoutMs: 15_000,
          });
          cleanups.push(() => closeNativeClient(sourceClient));
          expect(sourceClient.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          const source = assertCodexThreadStartResponse(
            await sourceClient.request(
              "thread/start",
              { cwd: native.cwd, dynamicTools: [] },
              { timeoutMs: 15_000 },
            ),
          );
          expect(source.model).toBe(NATIVE_MODEL);
          expect(source.modelProvider).toBe("settled-fixture");
          const sourceTurnId = await runNativePrompt(
            sourceClient,
            source.thread.id,
            "Initialize the source.",
          );
          await sourceClient.request(
            "thread/unsubscribe",
            { threadId: source.thread.id },
            { timeoutMs: 15_000 },
          );
          await closeNativeClient(sourceClient);

          const params = await createRunParams(fixture);
          params.modelId = HOST_MODEL;
          params.model = { ...params.model, id: HOST_MODEL };
          usePreparedApiKey(params, fixture.baseUrl);
          seedCodexTestBinding(params.sessionFile, {
            threadId: source.thread.id,
            cwd: native.cwd,
            connectionScope: "supervision",
            supervisionSourceThreadId: source.thread.id,
            model: source.model,
            modelProvider: source.modelProvider ?? undefined,
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            pendingSupervisionBranch: {
              sourceThreadId: source.thread.id,
              lastTurnId: sourceTurnId,
              connectionFingerprint: buildCodexAppServerConnectionFingerprint(appServer, agentDir),
            },
            appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
              appServer,
              agentDir,
            ),
          });
          const captureContext = vi.spyOn(
            settledContext,
            "captureCodexSettledTurnFinalizationContext",
          );
          const warn = vi.spyOn(embeddedAgentLog, "warn");
          const shared = trackSharedClient(cleanups);
          fixture.setPhase("action");
          const settledAttempt = await runCodexAppServerAttempt(params, {
            pluginConfig,
            clientFactory: shared.factory,
            nativeHookRelay: { enabled: false },
          });
          const client = shared.client();
          expect(settledAttempt.terminal).toEqual({ kind: "ok" });
          expect(settledAttempt.messagesSnapshot).toContainEqual(
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "completed-action",
              isError: false,
            }),
          );
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          expect(requests.map(({ body, account }) => ({ model: body.model, account }))).toEqual([
            { model: NATIVE_MODEL, account: `Bearer ${NATIVE_KEY}` },
            { model: NATIVE_MODEL, account: `Bearer ${NATIVE_KEY}` },
          ]);
          const context = settledAttempt.settledTurnFinalizationContext;
          const sibling = assertCodexThreadStartResponse(
            await client.request(
              "thread/start",
              { cwd: native.cwd, ephemeral: true, dynamicTools: [] },
              { timeoutMs: 15_000 },
            ),
          );
          const before = structuredClone({
            terminal: settledAttempt.terminal,
            messages: settledAttempt.messagesSnapshot,
            tools: settledAttempt.toolMetas,
            lifecycle: settledAttempt.itemLifecycle,
            replay: settledAttempt.replayMetadata,
          });
          const bindingBefore = structuredClone(
            await readCodexAppServerBinding(params.sessionFile),
          );
          const transcriptBefore = await readVisibleSessionTranscriptMessageEntries(
            transcriptTarget(params),
          );
          const sourceIsCurrent = sharedClients.captureSharedCodexAppServerCatalogLifetime(client);
          const nativeRequests = vi.spyOn(client, "request");
          const createClient = vi.spyOn(sharedClients, "createIsolatedCodexAppServerClient");
          const startClient = vi.spyOn(CodexAppServerClient, "start");
          const resolveHandoff = vi.spyOn(authBridge, "resolveCodexAppServerPreparedAuthHandoff");
          const resolveHostProfile = vi.spyOn(
            authBridge,
            "resolveCodexAppServerAuthProfileIdForAgent",
          );
          const resolveHostStore = vi.spyOn(authBridge, "resolveCodexAppServerAuthProfileStore");
          const applyHostAuth = vi.spyOn(authBridge, "applyCodexAppServerAuthProfile");
          const { hostCapabilities: _hostCapabilities, ...attempt } = params;
          fixture.setPhase("summary");
          await expect(
            runCodexSettledTurnFinalization(
              {
                attempt: { ...attempt, prompt: "Summarize the completed action." },
                settledAttempt,
              },
              { pluginConfig },
            ),
          ).rejects.toThrow("Codex settled-turn finalization context is unavailable");
          expect(createClient).not.toHaveBeenCalled();
          expect(startClient).not.toHaveBeenCalled();
          expect(resolveHandoff).not.toHaveBeenCalled();
          expect(resolveHostProfile).not.toHaveBeenCalled();
          expect(resolveHostStore).not.toHaveBeenCalled();
          expect(applyHostAuth).not.toHaveBeenCalled();
          expect(nativeRequests).not.toHaveBeenCalled();
          expect(requests).toHaveLength(0);
          expect(context).toEqual({ source: "unavailable" });
          expect(Object.isFrozen(context)).toBe(true);
          expect(captureContext).not.toHaveBeenCalled();
          expect(warn).toHaveBeenCalledWith(
            "codex settled-turn finalization context is unavailable",
            expect.objectContaining({ reason: "native_auth_finalization_unsupported" }),
          );
          expect(settledAttempt.settledTurnFinalizationContext).toBe(context);
          expect({
            terminal: settledAttempt.terminal,
            messages: settledAttempt.messagesSnapshot,
            tools: settledAttempt.toolMetas,
            lifecycle: settledAttempt.itemLifecycle,
            replay: settledAttempt.replayMetadata,
          }).toEqual(before);
          expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
          expect(
            await readVisibleSessionTranscriptMessageEntries(transcriptTarget(params)),
          ).toEqual(transcriptBefore);
          expect(sourceIsCurrent()).toBe(true);
          expect(client.getCloseError()).toBeUndefined();
          expect(sharedClients.releaseLeasedSharedCodexAppServerClient(client)).toBe(false);
          await expect(
            client.request(
              "thread/read",
              { threadId: source.thread.id, includeTurns: true },
              { timeoutMs: 15_000 },
            ),
          ).resolves.toMatchObject({
            thread: { id: source.thread.id },
          });
          fixture.setPhase("health");
          await runNativePrompt(client, sibling.thread.id, "Confirm the sibling still works.");
          expect(requests).toHaveLength(1);
          expect(requests[0]?.account).toBe(`Bearer ${NATIVE_KEY}`);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
        });
      },
    );

    it.for([
      {
        label: "ordinary prepared API key",
        homeScope: "agent" as const,
        preserveNativeModel: false,
        prepared: true,
      },
      {
        label: "preserveNativeModel-only host profile",
        homeScope: "agent" as const,
        preserveNativeModel: true,
        prepared: false,
      },
      {
        label: "ordinary user-home private host profile",
        homeScope: "user" as const,
        preserveNativeModel: false,
        prepared: false,
      },
    ])(
      "persists a host-authorized summary with the actual native selection ($label)",
      { timeout: 60_000 },
      async (scenario) => {
        await withNativeFixture(async (fixture, cleanups) => {
          const pluginConfig = {
            ...fixture.pluginConfig,
            appServer: { ...fixture.pluginConfig.appServer, homeScope: scenario.homeScope },
          };
          const sourceHome =
            scenario.homeScope === "user"
              ? fixture.native.codexHome
              : authBridge.resolveCodexAppServerHomeDir(fixture.agentDir);
          await writeNativeConfig(fixture, sourceHome, "openai", scenario.homeScope === "user");
          const nativeAuthBefore =
            scenario.homeScope === "user"
              ? await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")
              : undefined;
          const params = await createRunParams(fixture);
          if (scenario.prepared) {
            // The prepared key wins over a usable, differently authenticated profile.
            params.authProfileId = OTHER_PROFILE;
            usePreparedApiKey(params, fixture.baseUrl);
          }
          const shared = trackSharedClient(cleanups);
          const runOptions = {
            pluginConfig,
            clientFactory: shared.factory,
            nativeHookRelay: { enabled: false },
          };
          const initialized = await runCodexAppServerAttempt(
            { ...params, prompt: "Initialize the source." },
            runOptions,
          );
          expect(initialized.terminal).toEqual({ kind: "ok" });
          const initialBinding = await readCodexAppServerBinding(params.sessionFile);
          if (!initialBinding) {
            throw new Error("The ordinary native turn did not commit its binding");
          }
          expect(initialBinding.model).toBe(NATIVE_MODEL);
          expect(initialBinding.connectionScope).not.toBe("supervision");
          if (scenario.preserveNativeModel) {
            seedCodexTestBinding(params.sessionFile, {
              ...initialBinding,
              preserveNativeModel: true,
            });
            params.modelId = HOST_MODEL;
            params.model = { ...params.model, id: HOST_MODEL };
          }
          fixture.setPhase("action");
          params.runId = "run-settled-action";
          const settledAttempt = await runCodexAppServerAttempt(params, runOptions);
          expect(settledAttempt.terminal).toEqual({ kind: "ok" });
          const context = settledAttempt.settledTurnFinalizationContext;
          expect(context).toBeInstanceOf(settledContext.CodexSettledTurnContext);
          expect(Object.isFrozen(context)).toBe(true);
          const sourceKey = scenario.homeScope === "user" ? NATIVE_KEY : HOST_KEY;
          expect(
            fixture.requests.map(({ body, account }) => ({ model: body.model, account })),
          ).toEqual([
            { model: NATIVE_MODEL, account: `Bearer ${sourceKey}` },
            { model: NATIVE_MODEL, account: `Bearer ${sourceKey}` },
          ]);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          const bindingBefore = structuredClone(
            await readCodexAppServerBinding(params.sessionFile),
          );
          const transcriptBefore = await readVisibleSessionTranscriptMessageEntries(
            transcriptTarget(params),
          );
          const sourceClient = shared.client();
          const sourceRequests = vi.spyOn(sourceClient, "request");
          const realCreateClient = sharedClients.createIsolatedCodexAppServerClient;
          let summaryClient: CodexAppServerClient | undefined;
          let summaryRequests: MockInstance<CodexAppServerClient["request"]> | undefined;
          const createClient = vi
            .spyOn(sharedClients, "createIsolatedCodexAppServerClient")
            .mockImplementation(async (options) =>
              realCreateClient({
                ...options,
                onStartedClient(client) {
                  summaryClient = client;
                  summaryRequests = vi.spyOn(client, "request");
                  cleanups.push(() => closeNativeClient(client));
                  options?.onStartedClient?.(client);
                },
              }),
            );
          fixture.setPhase("summary");
          const { hostCapabilities: _hostCapabilities, ...attempt } = params;
          const finalization = await runCodexSettledTurnFinalization(
            { attempt: { ...attempt, prompt: "Summarize the completed action." }, settledAttempt },
            { pluginConfig },
          );
          expect(createClient).toHaveBeenCalledOnce();
          expect(summaryClient).not.toBe(sourceClient);
          expect(summaryClient?.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          expect(sourceRequests).not.toHaveBeenCalled();
          expect(sourceClient.getCloseError()).toBeUndefined();
          expect(
            fixture.requests.map(({ body, account }) => ({ model: body.model, account })),
          ).toEqual([{ model: NATIVE_MODEL, account: `Bearer ${HOST_KEY}` }]);
          expect(
            summaryRequests?.mock.calls
              .filter(([method]) => method === "account/login/start")
              .map(([, request]) => request),
          ).toEqual([{ type: "apiKey", apiKey: HOST_KEY }]);
          const startCall = summaryRequests?.mock.calls.find(
            ([method]) => method === "thread/start",
          );
          expect(startCall?.[1]).toMatchObject({
            model: NATIVE_MODEL,
            ephemeral: true,
            environments: [],
            dynamicTools: [],
          });
          expect(
            summaryRequests?.mock.calls.filter(([method]) => method === "thread/inject_items"),
          ).toHaveLength(1);
          const turns = summaryRequests?.mock.calls.filter(([method]) => method === "turn/start");
          expect(turns).toHaveLength(1);
          expect(finalization).toMatchObject({
            assistantTranscriptOwned: true,
            assistant: {
              provider: "openai",
              model: NATIVE_MODEL,
              api: "openai-responses",
              content: [{ type: "text", text: SUMMARY }],
            },
          });
          const transcript = await readVisibleSessionTranscriptMessageEntries(
            transcriptTarget(params),
          );
          expect(transcript.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
          expect(transcript.slice(transcriptBefore.length).map((entry) => entry.message)).toEqual([
            finalization.assistant,
          ]);
          expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          if (nativeAuthBefore !== undefined) {
            expect(await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")).toBe(
              nativeAuthBefore,
            );
          }
        });
      },
    );
  },
);
