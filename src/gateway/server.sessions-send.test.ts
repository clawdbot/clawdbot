import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock } from "vitest";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureEnv } from "../test-utils/env.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
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
  let sessionFile = resolveSessionTranscriptPath(sessionId);
  if (testState.sessionStorePath && commandParams.sessionKey) {
    const rawStore = JSON.parse(await fs.readFile(testState.sessionStorePath, "utf-8")) as Record<
      string,
      {
        sessionId?: string;
        sessionFile?: string;
      }
    >;
    const entry = rawStore[commandParams.sessionKey];
    if (entry?.sessionId === sessionId && entry.sessionFile) {
      sessionFile = entry.sessionFile;
    }
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });

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
  await fs.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf8");

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
    const details = result.details as {
      status?: string;
      reply?: string;
      sessionKey?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.reply).toBe("pong");
    expect(details.sessionKey).toBe("main");

    const firstCall = spy.mock.calls.at(0)?.[0] as
      | { lane?: string; inputProvenance?: { kind?: string; sourceTool?: string } }
      | undefined;
    expect(firstCall?.lane).toMatch(/^nested(?::|$)/);
    expect(firstCall?.inputProvenance?.kind).toBe("inter_session");
    expect(firstCall?.inputProvenance?.sourceTool).toBe("sessions_send");
  });
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
      const details = result.details as {
        status?: string;
        reply?: string;
        sessionKey?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.reply).toBe("labeled response");
      expect(details.sessionKey).toBe("agent:main:test-labeled-session");
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
        const details = result.details as {
          status?: string;
          reply?: string;
          sessionKey?: string;
        };
        expect(details.status).toBe("ok");
        expect(details.reply).toBe("orion response");
        expect(details.sessionKey).toBe("agent:orion:main");

        const orionCall = spy.mock.calls
          .map(([opts]) => opts as { sessionId?: string; sessionKey?: string })
          .find((call) => call.sessionKey === "agent:orion:main");
        expect(orionCall).toBeDefined();
        expect(orionCall?.sessionId).toBeTypeOf("string");

        const rawStore = JSON.parse(
          await fs.readFile(testState.sessionStorePath, "utf-8"),
        ) as Record<
          string,
          {
            sessionId?: string;
          }
        >;
        expect(rawStore["agent:orion:main"]?.sessionId).toBe(orionCall?.sessionId);
      } finally {
        testState.agentsConfig = undefined;
        testState.sessionStorePath = undefined;
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
});
