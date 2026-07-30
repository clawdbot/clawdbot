// sessions_send tests cover tool-driven agent-to-agent delivery, transcript
// updates, gateway auth, plugin routing, and emitted agent events.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { testing as agentStepTesting } from "../agents/tools/agent-step.test-support.js";
import { runSessionsSendA2AFlow } from "../agents/tools/sessions-send-tool.a2a.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";
import { runDirectSessionAnnounceScenario } from "./server.sessions-send.direct-announce.test-support.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  setTestPluginRegistry,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let gatewayPort: number;
const gatewayToken = "test-gateway-token-1234567890";
let envSnapshot: ReturnType<typeof captureEnv>;

type SessionSendTool = ReturnType<typeof createOpenClawTools>[number];
const SESSION_SEND_E2E_TIMEOUT_MS = 10_000;
const SESSION_SEND_DM_ROUTING_E2E_TIMEOUT_MS = 30_000;
let cachedSessionsSendTool: SessionSendTool | null = null;

function getSessionsSendTool(): SessionSendTool {
  if (cachedSessionsSendTool) {
    return cachedSessionsSendTool;
  }
  const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_send");
  if (!tool) {
    throw new Error("missing sessions_send tool");
  }
  cachedSessionsSendTool = tool;
  return cachedSessionsSendTool;
}

function expectSessionsSendDetails(
  result: { details?: unknown },
  expected: { reply: string; sessionKey: string },
): void {
  const details = result.details as {
    status?: string;
    reply?: string;
    sessionKey?: string;
  };
  expect(details.status).toBe("ok");
  expect(details.reply).toBe(expected.reply);
  expect(details.sessionKey).toBe(expected.sessionKey);
}

async function emitLifecycleAssistantReply(params: {
  opts: unknown;
  defaultSessionId: string;
  includeTimestamp?: boolean;
  resolveText: (extraSystemPrompt?: string) => string;
}) {
  const commandParams = params.opts as {
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    extraSystemPrompt?: string;
  };
  const sessionId = commandParams.sessionId ?? params.defaultSessionId;
  const runId = commandParams.runId ?? sessionId;
  if (!commandParams.sessionKey) {
    throw new Error("expected session key for lifecycle reply");
  }

  const startedAt = Date.now();
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt },
  });

  const text = params.resolveText(commandParams.extraSystemPrompt);
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(params.includeTimestamp ? { timestamp: Date.now() } : {}),
  };
  await persistSessionTranscriptTurn(
    {
      sessionId,
      sessionKey: commandParams.sessionKey,
      ...(testState.sessionStorePath ? { storePath: testState.sessionStorePath } : {}),
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: [{ message, now: Date.now() }],
    },
  );

  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now() },
  });
}

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN"]);
  gatewayPort = await getFreePort();
  const { approveDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
    await import("../infra/device-identity.js");
  const identity = loadOrCreateDeviceIdentity();
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: "openclaw-cli",
    clientMode: "cli",
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
    silent: false,
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: pending.request.scopes ?? ["operator.admin"],
  });
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  server = await startGatewayServer(gatewayPort);
});

beforeEach(() => {
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);
  process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
});

afterAll(async () => {
  await server.close();
  envSnapshot.restore();
});

describe("sessions_send gateway loopback", () => {
  it("returns reply when lifecycle ends before agent.wait", async () => {
    const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
    spy.mockImplementation(async (opts: unknown) =>
      emitLifecycleAssistantReply({
        opts,
        defaultSessionId: "main",
        includeTimestamp: true,
        resolveText: (extraSystemPrompt) => {
          if (extraSystemPrompt?.includes("Agent-to-agent reply step")) {
            return "REPLY_SKIP";
          }
          if (extraSystemPrompt?.includes("Agent-to-agent announce step")) {
            return "ANNOUNCE_SKIP";
          }
          return "pong";
        },
      }),
    );

    const tool = getSessionsSendTool();

    const result = await tool.execute("call-loopback", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 5,
    });
    expectSessionsSendDetails(result, { reply: "pong", sessionKey: "main" });

    const firstCall = spy.mock.calls.at(0)?.[0] as
      | { lane?: string; inputProvenance?: { kind?: string; sourceTool?: string } }
      | undefined;
    expect(firstCall?.lane).toMatch(/^nested(?::|$)/);
    expect(firstCall?.inputProvenance?.kind).toBe("inter_session");
    expect(firstCall?.inputProvenance?.sourceTool).toBe("sessions_send");
  });

  it.each([
    {
      label: "direct",
      sessionKey: "agent:main:feishu:direct:ou_announce_recipient",
      expectedAccountId: undefined,
    },
    {
      label: "dm alias",
      sessionKey: "agent:main:feishu:dm:ou_announce_recipient",
      expectedAccountId: undefined,
    },
    {
      label: "account-scoped direct",
      sessionKey: "agent:main:feishu:work:direct:ou_announce_recipient",
      expectedAccountId: "work",
    },
    {
      label: "account-scoped dm alias",
      sessionKey: "agent:main:feishu:work:dm:ou_announce_recipient",
      expectedAccountId: "work",
    },
  ])(
    "delivers a $label session announcement through the authenticated Gateway without stored delivery context",
    { timeout: SESSION_SEND_DM_ROUTING_E2E_TIMEOUT_MS },
    async ({ sessionKey, expectedAccountId }) => {
      await runDirectSessionAnnounceScenario({ sessionKey, expectedAccountId });
    },
  );

  it(
    "announces through gateway send using external deliveryContext over stale webchat session fields",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-route-"));
      const sendCalls: Array<{
        to?: string;
        text?: string;
        accountId?: string | null;
        threadId?: string | number | null;
      }> = [];
      const whatsappPlugin = createOutboundTestPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => {
            const target = to?.trim();
            return target
              ? { ok: true, to: target }
              : { ok: false, error: new Error("missing target") };
          },
          sendText: async (ctx) => {
            sendCalls.push({
              to: ctx.to,
              text: ctx.text,
              accountId: ctx.accountId,
              threadId: ctx.threadId,
            });
            return { channel: "whatsapp", messageId: "wa-proof-msg" };
          },
        },
        messaging: {
          normalizeTarget: (raw) => raw,
        },
      });
      setTestPluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: {
              ...whatsappPlugin,
              config: {
                ...whatsappPlugin.config,
                listAccountIds: () => ["work"],
              },
            },
          },
        ]),
      );

      testState.sessionStorePath = path.join(dir, "sessions.json");
      try {
        await writeSessionStore({
          entries: {
            "agent:main:whatsapp:direct:peer-1": {
              sessionId: "sess-whatsapp-peer",
              updatedAt: Date.now(),
              channel: "webchat",
              lastChannel: "webchat",
              lastTo: "session:dashboard",
              route: {
                channel: "webchat",
                target: { to: "session:dashboard" },
              },
              deliveryContext: {
                channel: "whatsapp",
                to: "peer-1",
              },
              origin: {
                provider: "whatsapp",
                accountId: "work",
                threadId: "thread-77",
              },
            },
          },
        });

        agentStepTesting.setDepsForTest({
          agentCommandFromIngress: async () => ({
            payloads: [{ text: "announce through channel", mediaUrl: null }],
            meta: { durationMs: 1 },
          }),
        });

        await runSessionsSendA2AFlow({
          targetSessionKey: "agent:main:whatsapp:direct:peer-1",
          displayKey: "agent:main:whatsapp:direct:peer-1",
          message: "ping",
          announceTimeoutMs: 5_000,
          maxPingPongTurns: 0,
          roundOneReply: "target response",
        });

        await vi.waitFor(
          () =>
            expect(sendCalls).toEqual([
              {
                to: "peer-1",
                text: "announce through channel",
                accountId: "work",
                threadId: "thread-77",
              },
            ]),
          { timeout: 5_000 },
        );
      } finally {
        agentStepTesting.setDepsForTest();
        testState.sessionStorePath = undefined;
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it(
    "does not re-announce a trailing message-tool delivery mirror after a waited A2A run",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-mirror-"));
      const sessionKey = "agent:main:whatsapp:direct:peer-1";
      const sessionId = "sess-whatsapp-mirror";
      const runId = `run-message-tool-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const deliveredReply = "already delivered source reply";
      const sendCalls: Array<{
        to?: string;
        text?: string;
        accountId?: string | null;
        threadId?: string | number | null;
      }> = [];
      setTestPluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "whatsapp",
              label: "WhatsApp",
              outbound: {
                deliveryMode: "direct",
                resolveTarget: ({ to }) => {
                  const target = to?.trim();
                  return target
                    ? { ok: true, to: target }
                    : { ok: false, error: new Error("missing target") };
                },
                sendText: async (ctx) => {
                  sendCalls.push({
                    to: ctx.to,
                    text: ctx.text,
                    accountId: ctx.accountId,
                    threadId: ctx.threadId,
                  });
                  return { channel: "whatsapp", messageId: "wa-duplicate-proof-msg" };
                },
              },
              messaging: {
                normalizeTarget: (raw) => raw,
              },
            }),
          },
        ]),
      );

      testState.sessionStorePath = path.join(dir, "sessions.json");
      try {
        await writeSessionStore({
          entries: {
            [sessionKey]: {
              sessionId,
              updatedAt: Date.now(),
              deliveryContext: {
                channel: "whatsapp",
                to: "peer-1",
              },
              origin: {
                provider: "whatsapp",
                accountId: "work",
                threadId: "thread-77",
              },
            },
          },
        });
        await persistSessionTranscriptTurn(
          { sessionId, sessionKey, storePath: testState.sessionStorePath },
          {
            cwd: dir,
            updateMode: "none",
            messages: [
              {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "previous real reply" }],
                  timestamp: 1,
                },
              },
              {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "call-message-duplicate-proof",
                      name: "message",
                      arguments: {
                        action: "send",
                        message: deliveredReply,
                      },
                    },
                  ],
                  timestamp: 2,
                },
              },
              {
                message: {
                  role: "toolResult",
                  toolName: "message",
                  toolCallId: "call-message-duplicate-proof",
                  content: { ok: true, messageId: "24271", chatId: "peer-1" },
                  timestamp: 3,
                },
              },
              {
                message: {
                  role: "assistant",
                  provider: "openclaw",
                  model: "delivery-mirror",
                  content: [{ type: "text", text: deliveredReply }],
                  timestamp: 4,
                },
              },
            ],
          },
        );

        const { callGateway } = await import("./call.js");
        const history = await callGateway<{ messages?: unknown[] }>({
          method: "chat.history",
          params: { sessionKey, limit: 10 },
          timeoutMs: 5_000,
        });
        expect(history.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({ type: "text", text: deliveredReply }),
              ]),
              openclawMessageToolMirror: expect.objectContaining({
                toolName: "message",
                toolCallId: "call-message-duplicate-proof",
              }),
            }),
          ]),
        );

        const startedAt = Date.now();
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt, endedAt: Date.now() },
        });
        agentStepTesting.setDepsForTest({
          agentCommandFromIngress: async () => ({
            payloads: [{ text: "SHOULD_NOT_SEND", mediaUrl: null }],
            meta: { durationMs: 1 },
          }),
        });

        await runSessionsSendA2AFlow({
          targetSessionKey: sessionKey,
          displayKey: sessionKey,
          message: "proof ping",
          announceTimeoutMs: 5_000,
          maxPingPongTurns: 0,
          waitRunId: runId,
        });

        expect(sendCalls).toEqual([]);
      } finally {
        agentStepTesting.setDepsForTest();
        testState.sessionStorePath = undefined;
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
});

describe("sessions_send label lookup", () => {
  it(
    "finds session by label and sends message",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      // This is an operator feature; enable broader session tool targeting for this test.
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ tools: { sessions: { visibility: "all" } } }, null, 2) + "\n",
        "utf-8",
      );

      const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
      spy.mockImplementation(async (opts: unknown) =>
        emitLifecycleAssistantReply({
          opts,
          defaultSessionId: "test-labeled",
          resolveText: () => "labeled response",
        }),
      );

      // First, create a session with a label via sessions.patch
      const { callGateway } = await import("./call.js");
      await callGateway({
        method: "sessions.patch",
        params: { key: "test-labeled-session", label: "my-test-worker" },
        timeoutMs: 5000,
      });

      const tool = createOpenClawTools({
        config: {
          tools: {
            sessions: {
              visibility: "all",
            },
          },
        },
      }).find((candidate) => candidate.name === "sessions_send");
      if (!tool) {
        throw new Error("missing sessions_send tool");
      }

      // Send using label instead of sessionKey
      const result = await tool.execute("call-by-label", {
        label: "my-test-worker",
        message: "hello labeled session",
        timeoutSeconds: 5,
      });
      expectSessionsSendDetails(result, {
        reply: "labeled response",
        sessionKey: "agent:main:test-labeled-session",
      });
    },
  );
});

describe("sessions_send agent targeting", () => {
  it(
    "starts configured agent main session by agentId before sending",
    { timeout: SESSION_SEND_E2E_TIMEOUT_MS },
    async () => {
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-agent-"));
      const config: OpenClawConfig = {
        tools: {
          sessions: {
            visibility: "all",
          },
          agentToAgent: {
            enabled: true,
          },
        },
        agents: {
          list: [{ id: "main", default: true }, { id: "orion" }],
        },
      };

      testState.sessionStorePath = path.join(dir, "sessions.json");
      testState.agentsConfig = config.agents;
      try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
            },
          },
        });

        const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
        spy.mockImplementation(async (opts: unknown) =>
          emitLifecycleAssistantReply({
            opts,
            defaultSessionId: "orion-created",
            resolveText: () => "orion response",
          }),
        );
        spy.mockClear();

        const tool = createOpenClawTools({
          agentSessionKey: "agent:main:main",
          config,
        }).find((candidate) => candidate.name === "sessions_send");
        if (!tool) {
          throw new Error("missing sessions_send tool");
        }

        const result = await tool.execute("call-agent-id", {
          agentId: "orion",
          message: "hello orion",
          timeoutSeconds: 5,
        });
        expectSessionsSendDetails(result, {
          reply: "orion response",
          sessionKey: "agent:orion:main",
        });

        const orionCall = spy.mock.calls
          .map(([opts]) => opts as { sessionId?: string; sessionKey?: string })
          .find((call) => call.sessionKey === "agent:orion:main");
        expect(orionCall).toBeDefined();
        expect(orionCall?.sessionId).toBeTypeOf("string");

        const stored = loadSessionEntry({
          sessionKey: "agent:orion:main",
          storePath: testState.sessionStorePath,
        });
        expect(stored?.sessionId).toBe(orionCall?.sessionId);
      } finally {
        testState.agentsConfig = undefined;
        testState.sessionStorePath = undefined;
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
});

type DirectMessageRequesterRoutingCase = {
  label: string;
  requesterSessionKey: string;
  dmScope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  bindingDmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  defaultBindingDmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  bindingAccountId?: string;
  bindingAgentId?: string;
  bindingPeerId?: string;
  bindingTeamId?: string;
  expectedReplySessionKey: string;
};

describe("sessions_send direct-message requester routing", () => {
  it.each<DirectMessageRequesterRoutingCase>([
    {
      label: "legacy peer direct route",
      requesterSessionKey: "agent:main:direct:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "legacy peer dm route",
      requesterSessionKey: "agent:main:dm:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "legacy channel direct route",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "legacy channel dm route",
      requesterSessionKey: "agent:main:feishu:dm:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "legacy account direct route",
      requesterSessionKey: "agent:main:feishu:default:direct:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "legacy account dm route",
      requesterSessionKey: "agent:main:feishu:default:dm:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "isolated peer route",
      requesterSessionKey: "agent:main:direct:legacy-peer",
      dmScope: "per-peer",
      expectedReplySessionKey: "agent:main:direct:legacy-peer",
    },
    {
      label: "isolated channel route",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "per-channel-peer",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "isolated account route",
      requesterSessionKey: "agent:main:feishu:default:direct:legacy-peer",
      dmScope: "per-account-channel-peer",
      expectedReplySessionKey: "agent:main:feishu:default:direct:legacy-peer",
    },
    {
      label: "binding-isolated peer route",
      requesterSessionKey: "agent:main:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-peer",
      expectedReplySessionKey: "agent:main:direct:legacy-peer",
    },
    {
      label: "binding-isolated channel route",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-channel-peer",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "binding-isolated account route",
      requesterSessionKey: "agent:main:feishu:default:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-account-channel-peer",
      expectedReplySessionKey: "agent:main:feishu:default:direct:legacy-peer",
    },
    {
      label: "main binding overriding globally isolated peer route",
      requesterSessionKey: "agent:main:direct:legacy-peer",
      dmScope: "per-peer",
      bindingDmScope: "main",
      expectedReplySessionKey: "agent:main:main",
    },
    {
      label: "unresolved named-account isolated peer route",
      requesterSessionKey: "agent:main:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-peer",
      bindingAccountId: "work",
      expectedReplySessionKey: "agent:main:direct:legacy-peer",
    },
    {
      label: "unresolved named-account isolated channel route",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-channel-peer",
      bindingAccountId: "work",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "thread-scoped direct route",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer:thread:reply-root",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer:thread:reply-root",
    },
    {
      label: "direct route owned by another agent",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingAgentId: "stranger",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "erased named-account route owned by another agent",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingAgentId: "stranger",
      bindingAccountId: "work",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "named-account route inheriting globally isolated DM scope",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "per-peer",
      defaultBindingDmScope: "main",
      bindingAccountId: "work",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "named-account route with a trimmed wildcard peer",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-peer",
      bindingAccountId: "work",
      bindingPeerId: " * ",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "isolated route with a case-preserving peer binding",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-peer",
      bindingPeerId: "LEGACY-PEER",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "isolated route with session-erased team metadata",
      requesterSessionKey: "agent:main:feishu:direct:legacy-peer",
      dmScope: "main",
      bindingDmScope: "per-peer",
      bindingTeamId: "T123",
      expectedReplySessionKey: "agent:main:feishu:direct:legacy-peer",
    },
    {
      label: "group route with an opaque direct segment",
      requesterSessionKey: "agent:main:feishu:group:direct:legacy-peer",
      dmScope: "main",
      expectedReplySessionKey: "agent:main:feishu:group:direct:legacy-peer",
    },
  ] as const)(
    "returns a real cross-agent reply to the $label",
    { timeout: SESSION_SEND_DM_ROUTING_E2E_TIMEOUT_MS },
    async ({
      label,
      requesterSessionKey,
      dmScope,
      bindingDmScope,
      defaultBindingDmScope,
      bindingAccountId,
      bindingAgentId,
      bindingPeerId,
      bindingTeamId,
      expectedReplySessionKey,
    }) => {
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-dm-scope-"));
      // A2A follow-ups outlive tool.execute. Give every real Gateway case its
      // own agent so a preceding case can never satisfy this case's spy.
      const targetAgentId = `orion-${label.toLowerCase().replaceAll(" ", "-")}`;
      const targetSessionKey = `agent:${targetAgentId}:main`;
      const config: OpenClawConfig = {
        ...(bindingDmScope || defaultBindingDmScope || bindingAccountId || bindingAgentId
          ? {
              bindings: [
                ...(defaultBindingDmScope
                  ? [
                      {
                        type: "route" as const,
                        agentId: "main",
                        match: {
                          channel: "feishu",
                          accountId: "default",
                          peer: { kind: "direct" as const, id: "legacy-peer" },
                        },
                        session: { dmScope: defaultBindingDmScope },
                      },
                    ]
                  : []),
                {
                  type: "route",
                  agentId: bindingAgentId ?? "main",
                  match: {
                    channel: "feishu",
                    accountId: bindingAccountId ?? "default",
                    peer: { kind: "direct", id: bindingPeerId ?? "legacy-peer" },
                    ...(bindingTeamId ? { teamId: bindingTeamId } : {}),
                  },
                  ...(bindingDmScope ? { session: { dmScope: bindingDmScope } } : {}),
                },
              ],
            }
          : {}),
        session: { dmScope },
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true },
        },
        agents: {
          list: [
            { id: "main", default: true },
            { id: targetAgentId },
            ...(bindingAgentId ? [{ id: bindingAgentId }] : []),
          ],
        },
      };

      testState.sessionStorePath = path.join(dir, "sessions.json");
      testState.agentsConfig = config.agents;
      testState.sessionConfig = config.session;
      try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
        await writeSessionStore({
          entries: {
            "agent:main:main": { sessionId: "dm-scope-main", updatedAt: Date.now() },
            [requesterSessionKey]: { sessionId: "dm-scope-legacy", updatedAt: Date.now() },
            [targetSessionKey]: { sessionId: "dm-scope-orion", updatedAt: Date.now() },
          },
        });

        const spy = agentCommand as unknown as Mock<(opts: unknown) => Promise<void>>;
        spy.mockReset();
        spy.mockImplementation(async (opts: unknown) =>
          emitLifecycleAssistantReply({
            opts,
            defaultSessionId: `dm-scope-${targetAgentId}`,
            resolveText: (extraSystemPrompt) => {
              if (extraSystemPrompt?.includes("Agent-to-agent reply step")) {
                return "REPLY_SKIP";
              }
              if (extraSystemPrompt?.includes("Agent-to-agent announce step")) {
                return "ANNOUNCE_SKIP";
              }
              return "orion received the session message";
            },
          }),
        );

        const tool = createOpenClawTools({
          agentSessionKey: requesterSessionKey,
          agentChannel: "feishu",
          config,
        }).find((candidate) => candidate.name === "sessions_send");
        if (!tool) {
          throw new Error("missing sessions_send tool");
        }

        const result = await tool.execute("call-dm-scope-routing", {
          sessionKey: targetSessionKey,
          message: "deliver to the monitored requester session",
          timeoutSeconds: 10,
        });
        expectSessionsSendDetails(result, {
          reply: "orion received the session message",
          sessionKey: targetSessionKey,
        });

        const runId = (result.details as { runId?: string }).runId;
        expect(runId).toBeTypeOf("string");
        const targetCall = spy.mock.calls
          .map(
            ([opts]) =>
              opts as {
                runId?: string;
                sessionKey?: string;
                inputProvenance?: { sourceSessionKey?: string };
              },
          )
          .find((opts) => opts.sessionKey === targetSessionKey && opts.runId === runId);
        if (!targetCall) {
          const observedRuns = spy.mock.calls.slice(-6).map(([opts]) => {
            const call = opts as { runId?: string; sessionKey?: string };
            return { runId: call.runId, sessionKey: call.sessionKey };
          });
          throw new Error(
            `Target run ${runId} for ${targetSessionKey} was not observed: ${JSON.stringify(observedRuns)}`,
          );
        }
        expect(targetCall?.inputProvenance?.sourceSessionKey).toBe(expectedReplySessionKey);

        await vi.waitFor(
          () => {
            expect(
              spy.mock.calls.some(([opts]) => {
                const call = opts as {
                  sessionKey?: string;
                  extraSystemPrompt?: string;
                  inputProvenance?: { sourceSessionKey?: string };
                };
                return (
                  call.sessionKey === expectedReplySessionKey &&
                  call.inputProvenance?.sourceSessionKey === targetSessionKey &&
                  call.extraSystemPrompt?.includes("Agent-to-agent reply step")
                );
              }),
            ).toBe(true);
          },
          { timeout: 10_000, interval: 25 },
        );
        if (expectedReplySessionKey !== requesterSessionKey) {
          expect(
            spy.mock.calls.some(([opts]) => {
              const call = opts as {
                sessionKey?: string;
                extraSystemPrompt?: string;
                inputProvenance?: { sourceSessionKey?: string };
              };
              return (
                call.sessionKey === requesterSessionKey &&
                call.inputProvenance?.sourceSessionKey === targetSessionKey &&
                call.extraSystemPrompt?.includes("Agent-to-agent reply step")
              );
            }),
          ).toBe(false);
        }
      } finally {
        testState.sessionConfig = undefined;
        testState.agentsConfig = undefined;
        testState.sessionStorePath = undefined;
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
});
