import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
} from "../../../../src/agents/internal-runtime-context.js";
import { markCompleteReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { loadSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { readSessionMessagesAsync } from "../../../../src/gateway/session-transcript-readers.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const PROOF_CHANNEL_ID = "runtime-only-inbound-proof";
const RUNTIME_EVENT_STUB = "Continue the OpenClaw runtime event.";
const ISOLATED_GATEWAY_ENV_KEYS = [
  "HOME",
  "NODE_ENV",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

type ProofInbound = {
  body: string;
  messageId: string;
  quoteBody?: string;
  sessionKey: string;
};

type ProofDispatch = (input: ProofInbound) => Promise<void>;

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  resetTaskRegistryForTests({ persist: false });
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return text.split(needle).length - 1;
}

function writeResponsesEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeAssistantResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: nextId("provider-message"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeResponsesEvents(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: nextId("provider-response"),
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function writeInboundProofPlugin(params: {
  dispatchKey: string;
  pluginDir: string;
}): Promise<void> {
  await fs.mkdir(params.pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PROOF_CHANNEL_ID,
        activation: { onStartup: true },
        channels: [PROOF_CHANNEL_ID],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(params.pluginDir, "index.cjs"),
    [
      `const channelId = ${JSON.stringify(PROOF_CHANNEL_ID)};`,
      `const dispatchKey = ${JSON.stringify(params.dispatchKey)};`,
      "let deliverySequence = 0;",
      "module.exports = {",
      "  id: channelId,",
      "  register(api) {",
      "    api.registerChannel({",
      "      plugin: {",
      "        id: channelId,",
      "        meta: {",
      "          id: channelId,",
      '          label: "Runtime-only Inbound Proof",',
      '          selectionLabel: "Runtime-only Inbound Proof",',
      '          docsPath: "/channels/runtime-only-inbound-proof",',
      '          blurb: "Injects admitted inbound turns for Gateway boundary tests.",',
      "        },",
      '        capabilities: { chatTypes: ["direct"] },',
      "        config: {",
      '          listAccountIds: () => ["default"],',
      '          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),',
      "          isEnabled: () => true,",
      "          isConfigured: () => true,",
      "        },",
      "        outbound: {",
      '          deliveryMode: "direct",',
      "          sendText: async () => ({ channel: channelId, messageId: `outbound-${++deliverySequence}` }),",
      "        },",
      "        gateway: {",
      "          startAccount: async (ctx) => {",
      "            globalThis[dispatchKey] = async ({ body, messageId, quoteBody, sessionKey }) => {",
      "              const ctxPayload = await ctx.channelRuntime.inbound.buildContext({",
      "                channel: channelId,",
      '                accountId: "default",',
      "                messageId,",
      "                messageIdFull: messageId,",
      "                timestamp: Date.now(),",
      '                from: "runtime-only-proof:sender",',
      '                sender: { id: "proof-sender", name: "Proof Sender" },',
      '                conversation: { kind: "direct", id: "proof-conversation", label: "Proof Conversation" },',
      "                route: {",
      '                  agentId: "main",',
      '                  accountId: "default",',
      "                  routeSessionKey: sessionKey,",
      "                  dispatchSessionKey: sessionKey,",
      "                },",
      "                reply: {",
      '                  to: "proof-destination",',
      '                  originatingTo: "proof-destination",',
      "                },",
      "                message: { body, bodyForAgent: body, rawBody: body, commandBody: body },",
      "                access: { commands: { authorized: true } },",
      "                supplemental: quoteBody",
      '                  ? { quote: { id: "quoted-message", body: quoteBody, sender: "Quoted Sender", senderAllowed: true } }',
      "                  : undefined,",
      '                channelIngress: "unsupported",',
      "              });",
      "              await ctx.channelRuntime.inbound.dispatch({",
      "                cfg: ctx.cfg,",
      "                channel: channelId,",
      '                accountId: "default",',
      '                route: { agentId: "main", sessionKey },',
      "                ctxPayload,",
      "                delivery: {",
      "                  deliver: async (payload) => ({",
      "                    messageIds: [`delivery-${++deliverySequence}`],",
      "                    visibleReplySent: true,",
      '                    content: typeof payload?.text === "string" ? payload.text : "",',
      "                  }),",
      "                },",
      "                replyPipeline: {},",
      "                record: {",
      "                  onRecordError: (error) => { throw error; },",
      "                },",
      "              });",
      "            };",
      "            try {",
      "              await new Promise((resolve) => {",
      "                if (ctx.abortSignal.aborted) {",
      "                  resolve();",
      "                  return;",
      "                }",
      '                ctx.abortSignal.addEventListener("abort", resolve, { once: true });',
      "              });",
      "            } finally {",
      "              delete globalThis[dispatchKey];",
      "            }",
      "          },",
      "        },",
      "      },",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

function getProofDispatch(dispatchKey: string): ProofDispatch | undefined {
  const value = (globalThis as Record<string, unknown>)[dispatchKey];
  return typeof value === "function" ? (value as ProofDispatch) : undefined;
}

function getResponseInput(request: Record<string, unknown>): unknown[] {
  return Array.isArray(request.input) ? request.input : [];
}

async function readSessionTranscript(sessionKey: string): Promise<unknown[]> {
  const entry = loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
  if (!entry?.sessionId) {
    throw new Error(`Session entry ${sessionKey} was not persisted`);
  }
  return await readSessionMessagesAsync(
    {
      agentId: "main",
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
    },
    { mode: "full", reason: "runtime-only inbound context Gateway boundary proof" },
  );
}

describe("Gateway runtime-only inbound context", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "keeps current inbound context out of the runtime stub and cleans the carrier after submission",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...ISOLATED_GATEWAY_ENV_KEYS]);
      const tempHome = tempDirs.make("openclaw-gateway-runtime-only-inbound-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", PROOF_CHANNEL_ID);
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      const dispatchKey = nextId("openclaw-runtime-only-proof-dispatch");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(path.dirname(configPath), { recursive: true }),
        writeInboundProofPlugin({ dispatchKey, pluginDir }),
      ]);

      const token = nextId("runtime-only-proof-token");
      // Resolve the plugin runtime through the exact-head dist artifact, matching production
      // instead of synchronously recompiling the entire SDK graph inside the Vitest worker.
      for (const [key, value] of Object.entries({
        HOME: tempHome,
        NODE_ENV: "production",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
      deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");

      const providerRequests: Array<Record<string, unknown>> = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          providerRequests.push(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          );
          writeAssistantResponse(response, nextId("gateway-runtime-only-proof-reply"));
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("mock OpenAI Responses server did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
          "gpt-runtime-only-inbound-proof",
        );
        const config = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                models: provider.config.models.map((model) =>
                  Object.assign({}, model, { input: Array.from(model.input) }),
                ),
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          // This proof exercises provider-bound and transcript behavior only. Denying source
          // delivery keeps an intentionally bodyless synthetic turn out of recovery custody.
          session: { sendPolicy: { default: "deny" } },
          plugins: {
            enabled: true,
            allow: [PROOF_CHANNEL_ID],
            load: { paths: [pluginDir] },
            entries: { [PROOF_CHANNEL_ID]: { enabled: true } },
            slots: { memory: "none" },
          },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-runtime-only-inbound-context",
        });
        const runtimeConfig = getRuntimeConfigSnapshot();
        if (!runtimeConfig) {
          throw new Error("gateway runtime config snapshot was not initialized");
        }
        markCompleteReplyConfig(runtimeConfig, { runtimeMode: "full" });
        await expect
          .poll(() => typeof getProofDispatch(dispatchKey), { timeout: 10_000, interval: 50 })
          .toBe("function");
        const dispatch = getProofDispatch(dispatchKey);
        if (!dispatch) {
          throw new Error("runtime-only proof channel did not register its inbound dispatcher");
        }

        const sessionKey = "agent:main:runtime-only-inbound-proof";
        const runtimeEventMarker = nextId("runtime-system-event-marker");
        const inboundMarker = nextId("quoted-inbound-marker");
        const visibleUserMessage = nextId("visible-user-message");
        await expect(
          gateway.client.request<{ ok: boolean }>("system-event", {
            text: runtimeEventMarker,
            sessionKey,
            wake: false,
          }),
        ).resolves.toEqual({ ok: true });

        await dispatch({
          body: "",
          messageId: nextId("runtime-only-inbound-message"),
          quoteBody: inboundMarker,
          sessionKey,
        });
        expect(providerRequests).toHaveLength(1);
        const firstInput = getResponseInput(providerRequests[0] ?? {});
        const firstInputText = JSON.stringify(firstInput);
        expect(countOccurrences(firstInputText, RUNTIME_EVENT_STUB)).toBe(1);
        expect(countOccurrences(firstInputText, runtimeEventMarker)).toBe(1);
        expect(countOccurrences(firstInputText, inboundMarker)).toBe(1);
        const runtimeStubIndexes = firstInput.flatMap((item, index) =>
          JSON.stringify(item).includes(RUNTIME_EVENT_STUB) ? [index] : [],
        );
        const inboundMarkerIndexes = firstInput.flatMap((item, index) =>
          JSON.stringify(item).includes(inboundMarker) ? [index] : [],
        );
        expect(runtimeStubIndexes).toHaveLength(1);
        expect(inboundMarkerIndexes).toHaveLength(1);
        expect(inboundMarkerIndexes[0]).not.toBe(runtimeStubIndexes[0]);
        expect(JSON.stringify(firstInput[inboundMarkerIndexes[0] ?? -1])).toContain(
          INTERNAL_RUNTIME_CONTEXT_BEGIN,
        );

        await dispatch({
          body: visibleUserMessage,
          messageId: nextId("visible-inbound-message"),
          sessionKey,
        });
        expect(providerRequests).toHaveLength(2);
        const secondInputText = JSON.stringify(getResponseInput(providerRequests[1] ?? {}));
        expect(secondInputText).toContain(visibleUserMessage);
        expect(secondInputText).not.toContain(inboundMarker);

        await expect
          .poll(() => readSessionTranscript(sessionKey).then(JSON.stringify), {
            timeout: 15_000,
            interval: 50,
          })
          .toContain(visibleUserMessage);
        const transcriptText = JSON.stringify(await readSessionTranscript(sessionKey));
        expect(transcriptText).toContain(RUNTIME_EVENT_STUB);
        expect(transcriptText).toContain(visibleUserMessage);
        expect(transcriptText).not.toContain(inboundMarker);
        expect(transcriptText).not.toContain(OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE);
        expect(transcriptText).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);

        process.stdout.write(
          `gateway-runtime-only-inbound-context-proof ${JSON.stringify({
            gateway: "ephemeral",
            channel: "mock",
            provider: "mock-openai-responses",
            runtimeStubCount: countOccurrences(firstInputText, RUNTIME_EVENT_STUB),
            inboundContextCarrierSeparated: inboundMarkerIndexes[0] !== runtimeStubIndexes[0],
            carrierRemovedBeforeNextTurn: !secondInputText.includes(inboundMarker),
            carrierAbsentFromTranscript: !transcriptText.includes(inboundMarker),
          })}\n`,
        );
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Gateway runtime-only inbound proof complete" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        delete (globalThis as Record<string, unknown>)[dispatchKey];
        envSnapshot.restore();
      }
    },
  );
});
