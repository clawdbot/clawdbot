import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, inject, it, vi } from "vitest";
import type {
  TranscriptsGetResult,
  TranscriptsListResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../src/test-utils/env.js";
import { withIsolatedTestHome } from "../../test/test-env.js";

type TranscriptCapturePorts = { gateway: number; provider: number };

declare module "vitest" {
  export interface ProvidedContext {
    transcriptCapturePorts?: TranscriptCapturePorts;
  }
}

type CaptureArguments = { action: "start" | "stop" | "summarize" } & Record<string, unknown>;
type ScriptedCall = {
  callId: string;
  agentId: "main" | "agent-b";
  args: CaptureArguments;
  output?: string;
};
type DiscordCaptureFixture = {
  register(api: OpenClawPluginApi): void;
  bindPublishedRuntime(): void;
  rotateManager(cfg: OpenClawConfig): Promise<void>;
  expectReady(): Promise<{ speakerId: string; speakerLabel: string; voiceSessionKey: string }>;
  recordAfterTurn(): Promise<void>;
  beginLateDelivery(): Promise<void>;
  finishLateDelivery(): Promise<void>;
  close(): Promise<void>;
  restore(): void;
  restoreRuntime(this: void): void;
};
type DiscordCaptureTestApi = {
  loadDiscordGatewayCaptureFixture(this: void): Promise<{
    captureTarget: { accountId: string; guildId: string; channelId: string };
    capturedText: string;
    lateText: string;
    createDiscordGatewayCaptureFixture(
      this: void,
      params: {
        cfg: OpenClawConfig;
        test: { expect: typeof expect; vi: typeof vi };
      },
    ): DiscordCaptureFixture;
  }>;
};

function sendResponse(response: ServerResponse, item: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

describe("Gateway admitted Discord transcript capture", () => {
  it("fences late STT and preserves the admitted owner's history after a room route changes", async () => {
    const proofStartedAt = Date.now();
    const phase = (name: string) => {
      writeSync(
        2,
        `[capture-proof] ${JSON.stringify({ phase: name, elapsedMs: Date.now() - proofStartedAt })}\n`,
      );
    };
    phase("setup:start");
    const ports = inject("transcriptCapturePorts");
    if (
      ports !== undefined &&
      (ports.gateway === ports.provider ||
        [ports.gateway, ports.provider].some(
          (port) => !Number.isInteger(port) || port <= 0 || port > 65535,
        ))
    ) {
      throw new Error(
        "transcriptCapturePorts requires distinct integer gateway and provider ports",
      );
    }
    // Manual live validation adds a clean environment and an OS egress fence.
    // Ordinary CI uses this scripted loopback provider and the Node socket guard below.
    const env = captureEnv([
      "NODE_ENV",
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_GMAIL_WATCHER",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_CANVAS_HOST",
      "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      "OPENCLAW_SKIP_PROVIDERS",
      "OPENCLAW_BUILD_PRIVATE_QA",
      "OPENCLAW_QA_FORCE_RUNTIME",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_PORT",
    ]);
    const isolated = withIsolatedTestHome({ mode: "hermetic" });
    const stateDir = path.join(isolated.tempHome, ".openclaw");
    const workspace = path.join(isolated.tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    let gateway:
      | Awaited<
          ReturnType<typeof import("../../src/gateway/test-helpers.e2e.js").startGatewayWithClient>
        >
      | undefined;
    let fixture: DiscordCaptureFixture | undefined;
    let restoreDiscordRuntime: (() => void) | undefined;
    let routedService:
      | ReturnType<
          typeof import("../../src/transcripts/auto-start.js").createTranscriptsAutoStartService
        >
      | undefined;
    let cleanupRuntime: (() => Promise<void>) | undefined;
    const requests: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const calls: ScriptedCall[] = [];
    const deniedConnections: string[] = [];
    let providerPort: number | undefined;
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    const selectedGatewayPort = () => ports?.gateway ?? Number(process.env.OPENCLAW_GATEWAY_PORT);
    // The native method must retain each caller's socket, supplied by Reflect.apply below.
    // oxlint-disable-next-line typescript/unbound-method
    const originalConnect = Socket.prototype.connect;
    // Reject unexpected Node HTTP(S), WS and fetch destinations. This guard does
    // not isolate native transports or child processes; the manual OS fence does.
    const socketFence = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
      this: Socket,
      ...args: unknown[]
    ) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const options = asOptionalRecord(normalized[0]);
      const host = options?.host ?? normalized[1];
      const port = Number(options?.port ?? normalized[0]);
      // startGatewayWithClient publishes its allocated port before opening its WS client.
      const gatewayPort = selectedGatewayPort();
      if (
        host !== "127.0.0.1" ||
        !Number.isInteger(port) ||
        port <= 0 ||
        (port !== providerPort && port !== gatewayPort)
      ) {
        const reason = `unexpected socket destination ${String(host)}:${port}`;
        deniedConnections.push(reason);
        throw new Error(reason);
      }
      return Reflect.apply(originalConnect, this, args);
    });
    let currentCall: ScriptedCall | undefined;
    let awaitingOutput = false;
    let summaryTranscript: string | undefined;
    let summaryRequests = 0;
    const providerServer = createServer((request, response) => {
      void (async () => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer test");
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = asOptionalRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        expect(body?.model).toBe("capture-proof");
        expect(body?.stream).toBe(true);
        requests.push(body!);
        // Unscripted conversation calls fail visibly, including recording-only scan regressions.
        expect(currentCall, "unexpected model request outside an admitted tool turn").toBeDefined();
        const call = currentCall!;
        if (
          awaitingOutput &&
          (call.args.action === "stop" || call.args.action === "summarize") &&
          !body?.tools
        ) {
          expect(call.agentId).toBe("main");
          summaryRequests++;
          expect(summaryTranscript).toBeDefined();
          const summaryInput = JSON.stringify(body);
          expect(summaryInput).toContain(
            "Write concise meeting notes in the transcript's language.",
          );
          expect(summaryInput).toContain(summaryTranscript!);
          sendResponse(response, {
            type: "message",
            id: "msg_capture_summary",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  overview: "The participant supplied a synthetic capture note.",
                  decisions: [],
                  actionItems: [],
                  risks: [],
                }),
                annotations: [],
              },
            ],
          });
          return;
        }
        if (!awaitingOutput) {
          expect(body?.tools).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "transcripts" })]),
          );
          awaitingOutput = true;
          sendResponse(response, {
            type: "function_call",
            id: `fc_${call.callId}`,
            call_id: call.callId,
            name: "transcripts",
            arguments: JSON.stringify(call.args),
            status: "completed",
          });
          return;
        }
        const input = body?.input;
        expect(Array.isArray(input)).toBe(true);
        const inputItems = (input as unknown[]).map(asOptionalRecord);
        const result = inputItems.findLast(
          (item) => item?.type === "function_call_output" && item.call_id === call.callId,
        );
        const replayDiagnostics = JSON.stringify({
          expectedCallId: call.callId,
          input: inputItems.slice(-8).map((item) => ({
            type: item?.type,
            call_id: item?.call_id,
            outputType: typeof item?.output,
          })),
        }).slice(0, 2_048);
        expect(
          result,
          `the actual tool result must return through the runtime: ${replayDiagnostics}`,
        ).toBeDefined();
        expect(typeof result?.output).toBe("string");
        call.output = result!.output as string;
        currentCall = undefined;
        awaitingOutput = false;
        sendResponse(response, {
          type: "message",
          id: `msg_${call.callId}`,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: `Completed ${call.args.action}.`, annotations: [] },
          ],
        });
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end("Unexpected scripted capture request");
      });
    });
    try {
      // Both the fixture and selected plugin loaders use the production SDK artifact order.
      // VITEST and the explicit minimal flag retain test lifecycle isolation.
      setTestEnvValue("NODE_ENV", "production");
      for (const key of [
        "OPENCLAW_BUILD_PRIVATE_QA",
        "OPENCLAW_QA_FORCE_RUNTIME",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
        // These flags remove channel config from the effective runtime as well as
        // skipping startup. Minimal Gateway mode already skips channel login.
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_PROVIDERS",
      ]) {
        deleteTestEnvValue(key);
      }
      for (const key of [
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      ]) {
        setTestEnvValue(key, "1");
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      await Promise.all([
        fs.mkdir(workspace, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(ports?.provider ?? 0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (
        !address ||
        typeof address === "string" ||
        address.address !== "127.0.0.1" ||
        (ports !== undefined && address.port !== ports.provider)
      ) {
        throw new Error("Unexpected transcript fixture provider address");
      }
      providerPort = address.port;
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "capture-proof",
      );
      const testApiId = resolveRelativeBundledPluginPublicModuleId({
        fromModuleUrl: import.meta.url,
        pluginId: "discord",
        artifactBasename: "test-api.js",
      });
      const testApiPath = fileURLToPath(new URL(testApiId, import.meta.url));
      const discordPluginDir = path.dirname(testApiPath);
      phase("plugin-loader:import");
      const [
        { createPluginModuleLoader },
        { resolveOpenClawDevSourceRoot },
        { preparePluginLoaderAliases, resolvePluginRuntimeModulePathWithDiagnostics },
      ] = await Promise.all([
        import("../../src/plugins/loader-module-runtime.js"),
        import("../../src/plugins/dev-source-root.js"),
        import("../../src/plugins/sdk-alias.js"),
      ]);
      phase("plugin-loader:imported");
      const devSourceRoot = resolveOpenClawDevSourceRoot();
      const sdkAliases = preparePluginLoaderAliases({
        modulePath: testApiPath,
        devSourceRoot,
      });
      const isBuiltPath = (target: string) => /[/\\]dist(?:-runtime)?[/\\]/.test(target);
      const sdkTargets = ["runtime-store", "extension-shared", "channel-entry-contract"].map(
        (subpath) => {
          const target = sdkAliases.resolveAlias(`openclaw/plugin-sdk/${subpath}`);
          expect(target, `Missing SDK seam: ${subpath}`).toBeDefined();
          expect(
            isBuiltPath(target!),
            `The capture proof requires the built ${subpath} SDK; run pnpm build before using skip-build.`,
          ).toBe(true);
          return target!;
        },
      );
      const runtimeModule = resolvePluginRuntimeModulePathWithDiagnostics({ devSourceRoot });
      expect(runtimeModule.resolvedPath, JSON.stringify(runtimeModule)).toBeDefined();
      expect(isBuiltPath(runtimeModule.resolvedPath!)).toBe(true);
      await Promise.all(
        [...new Set([...sdkTargets, runtimeModule.resolvedPath!])].map((target) =>
          fs.access(target),
        ),
      );
      phase("plugin-sdk:built");
      // Use the runtime entry's loader graph so the fixture manager and model-selected
      // provider share Discord's lifecycle state. Vitest owns only the injected test utilities.
      const loadDiscordModule = createPluginModuleLoader({
        devSourceRoot,
        loaderFilename: path.join(discordPluginDir, "index.ts"),
      });
      phase("test-api:load");
      const { loadDiscordGatewayCaptureFixture } = loadDiscordModule(
        testApiPath,
      ) as DiscordCaptureTestApi;
      phase("test-api:loaded");
      phase("fixture-module:load");
      const { createDiscordGatewayCaptureFixture, captureTarget, capturedText, lateText } =
        await loadDiscordGatewayCaptureFixture();
      phase("fixture-module:loaded");
      phase("host-runtime:import");
      summaryTranscript = capturedText;
      const { startGatewayWithClient } = await import("../../src/gateway/test-helpers.e2e.js");
      const { createPluginRuntime } = await import("../../src/plugins/runtime/index.js");
      const { createPluginRegistry } = await import("../../src/plugins/registry.js");
      const { createPluginRecord } = await import("../../src/plugins/loader-records.js");
      const {
        getActivePluginRegistry,
        setActivePluginRegistry,
        captureActivePluginRegistrySnapshot,
        restoreActivePluginRegistrySnapshot,
      } = await import("../../src/plugins/runtime.js");
      const { getPluginRuntimeLoadContext } =
        await import("../../src/plugins/runtime/load-context.js");
      const { withPluginRuntimeRegistryScope } =
        await import("../../src/plugins/runtime/gateway-request-scope.js");
      const { refreshPreparedModelRuntimeSnapshots, loadPublishedGatewayReplyDispatchRuntime } =
        await import("../../src/agents/prepared-model-runtime.js");
      const { resetPreparedModelRuntimeSnapshotsForTest } =
        await import("../../src/agents/prepared-model-runtime.test-support.js");
      const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
        await import("../../src/config/config.js");
      const { resetConfigOverrides } = await import("../../src/config/runtime-overrides.js");
      const { drainSessionStoreWriterQueuesForTest, clearSessionStoreCacheForTest } =
        await import("../../src/config/sessions/store-writer-state.js");
      const { closeOpenClawStateDatabaseByPath } =
        await import("../../src/state/openclaw-state-db.js");
      const { activeSessions, resolveSourceProvider } =
        await import("../../src/transcripts/capture.js");
      const { createTranscriptsAutoStartService } =
        await import("../../src/transcripts/auto-start.js");
      const { readConfiguredTranscriptStarts } =
        await import("../../src/transcripts/configured-start-status.js");
      const { TranscriptsStore } = await import("../../src/transcripts/store.js");
      phase("host-runtime:imported");
      const previousRegistry = captureActivePluginRegistrySnapshot();
      cleanupRuntime = async () => {
        const ownedCaptures = () =>
          [...activeSessions.values()].filter(
            (capture) => capture.session.source.accountId === captureTarget.accountId,
          );
        try {
          for (const capture of ownedCaptures()) {
            await capture.finalization;
          }
          expect(ownedCaptures()).toEqual([]);
        } finally {
          try {
            await drainSessionStoreWriterQueuesForTest();
          } finally {
            clearSessionStoreCacheForTest();
            resetPreparedModelRuntimeSnapshotsForTest();
            closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
            resetConfigOverrides();
            clearRuntimeConfigSnapshot();
            clearConfigCache();
            restoreActivePluginRegistrySnapshot(previousRegistry);
          }
        }
      };
      resetConfigOverrides();
      const token = "synthetic-gateway-capture-token";
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true, workspace },
            { id: "agent-b", workspace },
          ],
          defaults: {
            workspace,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef, fallbacks: [] },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "discord",
              accountId: captureTarget.accountId,
              peer: { kind: "channel", id: captureTarget.channelId },
            },
          },
        ],
        channels: {
          discord: {
            // Minimal startup skips login; the health monitor must not start it later.
            healthMonitor: { enabled: false },
            accounts: {
              [captureTarget.accountId]: {
                token: "synthetic-discord-token",
                voice: { enabled: true, mode: "stt-tts" },
              },
            },
          },
        },
        gateway: { auth: { mode: "token", token } },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        plugins: {
          allow: ["discord"],
          entries: { discord: { enabled: true } },
          // Keep source proof on the same explicit plugin entry even when dist exists.
          load: { paths: [discordPluginDir] },
          slots: { memory: "none" },
        },
        tools: { allow: ["transcripts"], codeMode: false, toolSearch: false },
        transcripts: { enabled: true },
      };
      phase("host-runtime:create");
      const runtime = createPluginRuntime();
      phase("host-runtime:created");
      phase("fixture:create");
      fixture = createDiscordGatewayCaptureFixture({ cfg, test: { expect, vi } });
      restoreDiscordRuntime = fixture.restoreRuntime;
      phase("fixture:created");
      const registration = createPluginRegistry({ runtime, logger: console });
      const record = createPluginRecord({
        id: "discord",
        source: path.join(discordPluginDir, "index.ts"),
        rootDir: discordPluginDir,
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      registration.registry.plugins.push(record);
      fixture.register(registration.createApi(record, { config: cfg }));
      expect(registration.registry.diagnostics).toEqual([]);
      expect(record.transcriptSourceProviderIds).toEqual(["discord-voice"]);
      // Minimal startup retains this real registration; it skips monitor login/sidecars only.
      // This does not prove full plugin discovery or Discord monitor startup.
      setActivePluginRegistry(registration.registry);
      phase("gateway:start");
      gateway = await startGatewayWithClient({
        port: ports?.gateway,
        cfg,
        configPath,
        token,
        scopes: ["operator.admin"],
      });
      phase("gateway:started");
      await gateway.server.startupSettled;
      phase("gateway:settled");
      expect(getRuntimeConfig().channels?.discord).toMatchObject(cfg.channels!.discord!);
      const metadata = getPluginRuntimeLoadContext(registration.registry)?.metadataSnapshot;
      expect(metadata).toBeDefined();
      // Minimal startup skips the model-publication sidecar. Publish through its
      // production owner, retaining the real fixture registration for both agents.
      setActivePluginRegistry(
        registration.registry,
        undefined,
        "gateway-bindable",
        metadata!.workspaceDir,
      );
      phase("model-publication:start");
      await withPluginRuntimeRegistryScope(registration.registry, () =>
        refreshPreparedModelRuntimeSnapshots(getRuntimeConfig, {
          gatewayLifecycle: true,
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
          defaultWorkspaceDir: workspace,
          pluginMetadataSnapshot: metadata,
        }),
      );
      phase("model-publication:published");
      for (const agentId of ["main", "agent-b"]) {
        const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId });
        expect(published?.inboundPluginRegistry).toBe(registration.registry);
        const selectedRegistry = published?.pluginGeneration.pluginRegistry;
        const selectedProvider = selectedRegistry?.transcriptSourceProviders.find(
          (entry) => entry.provider.id === "discord-voice",
        )?.provider;
        expect(
          selectedProvider,
          JSON.stringify({
            agentId,
            selectedOwners: selectedRegistry?.plugins.map(({ id, status, source }) => ({
              id,
              status,
              source,
            })),
          }),
        ).toBe(registration.registry.transcriptSourceProviders[0]?.provider);
      }
      fixture.bindPublishedRuntime();
      phase("model-publication:verified");
      expect(gateway.port).not.toBe(providerPort);
      expect(getActivePluginRegistry()).toBe(registration.registry);
      const client = gateway.client;
      const sessionKeys = {
        main: `agent:main:capture-proof-${randomUUID()}`,
        "agent-b": `agent:agent-b:capture-proof-${randomUUID()}`,
      };
      const sessionId = `capture-${randomUUID()}`;
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
      const runTurn = async (args: CaptureArguments, agentId: "main" | "agent-b" = "main") => {
        const call: ScriptedCall = { callId: `call_capture_${calls.length}`, agentId, args };
        calls.push(call);
        currentCall = call;
        phase(`turn:${agentId}:${args.action}:request`);
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          sessionKey: sessionKeys[agentId],
          message: `Perform the synthetic capture ${args.action} operation.`,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        expect(accepted.runId).toEqual(expect.any(String));
        phase(`turn:${agentId}:${args.action}:accepted`);
        const completed = await client.request<{ status: string }>("agent.wait", {
          runId: accepted.runId,
          timeoutMs: 30_000,
        });
        phase(`turn:${agentId}:${args.action}:completed`);
        const diagnostics = JSON.stringify({
          agentId,
          action: args.action,
          completed,
          errors: errors.map((error) =>
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
          ),
          deniedConnections,
          providerRequestCount: requests.length,
        });
        expect(completed.status, diagnostics).toBe("ok");
        expect(errors, diagnostics).toEqual([]);
        expect(call.output).toBeDefined();
        expect(currentCall).toBeUndefined();
        return call.output!;
      };
      const start = await runTurn({
        action: "start",
        providerId: "discord-voice",
        ...captureTarget,
        sessionId,
      });
      expect(start).toContain(`Transcripts started: ${sessionId}`);
      const selector = /^Selector: (.+)$/m.exec(start)?.[1];
      expect(selector).toBeDefined();
      const speaker = await fixture.expectReady();
      const admitted = await store.readSession(selector!);
      expect(admitted).toMatchObject({ sessionId, metadata: { agentId: "main" } });
      expect(admitted?.source).toEqual({
        providerId: "discord-voice",
        ...captureTarget,
        agentId: "main",
      });
      const listed = await client.request<TranscriptsListResult>("transcripts.list", {});
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({
        selector,
        sessionId,
        agentId: "main",
        source: { providerId: "discord-voice", ...captureTarget },
        activeSubscription: true,
      });
      expect(requests).toHaveLength(2);

      await fixture.recordAfterTurn();
      const captured = await client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
        includeUtterances: true,
      });
      expect(captured.session).toMatchObject({
        selector,
        sessionId,
        utteranceCount: 1,
        activeSubscription: true,
      });
      expect(captured.utterances).toEqual([
        expect.objectContaining({
          sequence: 0,
          text: capturedText,
          final: true,
          speakerId: speaker.speakerId,
          speakerLabel: speaker.speakerLabel,
        }),
      ]);
      expect(requests).toHaveLength(2);
      expect(errors).toEqual([]);

      await fixture.beginLateDelivery();
      const stop = await runTurn({ action: "stop", selector });
      expect(stop).toContain(`Transcripts stopped: ${sessionId}`);
      expect(stop).toContain(`Selector: ${selector}`);
      await fixture.finishLateDelivery();
      const stopped = await client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
        includeUtterances: true,
      });
      expect(stopped.session).toMatchObject({
        selector,
        sessionId,
        agentId: "main",
        utteranceCount: 1,
        activeSubscription: false,
        stoppedAt: expect.any(String),
      });
      expect(stopped.utterances).toEqual(captured.utterances);
      expect(stopped.summary).toMatchObject({ utteranceCount: 1, source: "model" });
      expect(JSON.stringify(stopped)).not.toContain(lateText);
      const stoppedSession = await store.readSession(selector!);
      expect(stoppedSession).toEqual({ ...admitted, stoppedAt: stopped.session.stoppedAt });
      const utterances = await store.readUtterancesForSession(stoppedSession!);
      expect(utterances).toEqual([
        expect.objectContaining({
          text: capturedText,
          metadata: {
            channel: "discord",
            guildId: captureTarget.guildId,
            channelId: captureTarget.channelId,
            voiceSessionKey: speaker.voiceSessionKey,
          },
        }),
      ]);
      expect(requests).toHaveLength(5);
      expect(summaryRequests).toBe(1);

      // Rotate the real manager and transport while preserving the scenario's SDK spies.
      const routedConfig: OpenClawConfig = {
        ...cfg,
        bindings: [{ ...cfg.bindings![0]!, agentId: "agent-b" }],
        transcripts: {
          enabled: true,
          autoStart: [{ providerId: "discord-voice", ...captureTarget, whenOccupied: true }],
        },
      };
      await fixture.rotateManager(routedConfig);
      const routedWarnings: string[] = [];
      const routedContext: Parameters<typeof createTranscriptsAutoStartService>[0] = {
        stateDir,
        config: routedConfig,
        logger: {
          warn: (message) => {
            if (routedWarnings.length < 8) {
              routedWarnings.push(message);
            }
            writeSync(
              2,
              `[capture-proof] ${JSON.stringify({ phase: "routed-warning", message })}\n`,
            );
          },
        },
        caller: { kind: "operator", source: "scheduled" },
      };
      phase("routed-provider:resolve");
      const routedProvider = resolveSourceProvider("discord-voice", routedContext);
      const activeRegistry = getActivePluginRegistry();
      expect(
        routedProvider,
        JSON.stringify({
          activeRegistryIsFixture: activeRegistry === registration.registry,
          activeProviders: activeRegistry?.transcriptSourceProviders.map(
            ({ pluginId, source, provider: entryProvider }) => ({
              pluginId,
              source,
              providerId: entryProvider.id,
            }),
          ),
          resolvedProviderId: routedProvider?.id,
        }),
      ).toBe(registration.registry.transcriptSourceProviders[0]?.provider);
      phase("routed-provider:verified");
      routedService = createTranscriptsAutoStartService(routedContext);
      phase("routed-service:start");
      routedService.start();
      const readRoutedState = () => {
        const capture = [...activeSessions.values()].find(
          (candidate) => candidate.session.source.accountId === captureTarget.accountId,
        );
        return {
          capture: capture && {
            phase: capture.phase,
            session: { sessionId: capture.session.sessionId, metadata: capture.session.metadata },
          },
          starts: [...(readConfiguredTranscriptStarts(routedConfig.transcripts) ?? [])].map(
            ([index, fact]) => ({ index, diagnostic: fact.diagnostic }),
          ),
          warnings: routedWarnings,
        };
      };
      try {
        await expect.poll(readRoutedState).toMatchObject({
          capture: { phase: "active", session: { metadata: { agentId: "agent-b" } } },
        });
      } catch (error) {
        writeSync(
          2,
          `[capture-proof] ${JSON.stringify({ phase: "routed-service:failed", ...readRoutedState() })}\n`,
        );
        throw error;
      }
      phase("routed-service:active");
      const replacement = [...activeSessions.values()].find(
        (capture) => capture.session.source.accountId === captureTarget.accountId,
      )!;
      expect(replacement.session.sessionId).not.toBe(sessionId);
      expect(await store.readSession(selector!)).toEqual(stoppedSession);
      expect(await store.readUtterancesForSession(stoppedSession!)).toEqual(utterances);
      const savedSummary = await store.readSummary(stoppedSession!);
      const providerStop = vi.spyOn(replacement.provider, "stop");
      const sessionWrite = vi.spyOn(TranscriptsStore.prototype, "writeSession");
      const summaryWrite = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
      try {
        for (const action of ["stop", "summarize"] as const) {
          expect(await runTurn({ action, selector }, "agent-b")).toContain("session not found");
        }
        expect(providerStop).not.toHaveBeenCalled();
        expect(sessionWrite).not.toHaveBeenCalled();
        expect(summaryWrite).not.toHaveBeenCalled();
        expect(await store.readSession(selector!)).toEqual(stoppedSession);
        expect(await store.readSummary(stoppedSession!)).toEqual(savedSummary);
        expect(await store.readUtterancesForSession(stoppedSession!)).toEqual(utterances);
        expect(await runTurn({ action: "summarize", selector })).toContain(
          `Transcripts summarized: ${sessionId}`,
        );
        expect(summaryWrite).toHaveBeenCalledTimes(1);
        expect(providerStop).not.toHaveBeenCalled();
        expect(activeSessions.get(replacement.session.sessionId)).toBe(replacement);
      } finally {
        providerStop.mockRestore();
        sessionWrite.mockRestore();
        summaryWrite.mockRestore();
      }
      await routedService.stop();
      expect(requests).toHaveLength(12);
      expect(summaryRequests).toBe(2);
      expect(errors).toEqual([]);
      expect(deniedConnections).toEqual([]);
    } finally {
      phase("cleanup:start");
      // Keep the actual runtime and edge spies alive until sources, streams and Gateway settle.
      try {
        try {
          await routedService?.stop();
        } finally {
          await fixture?.close();
        }
      } finally {
        try {
          if (gateway) {
            try {
              await gateway.client.stopAndWait();
            } finally {
              await gateway.server.close({ reason: "synthetic transcript capture cleanup" });
            }
          }
        } finally {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          try {
            await cleanupRuntime?.();
          } finally {
            fixture?.restore();
            restoreDiscordRuntime?.();
            socketFence.mockRestore();
            isolated.cleanup();
            env.restore();
            phase("cleanup:done");
          }
        }
      }
    }
  });
});
