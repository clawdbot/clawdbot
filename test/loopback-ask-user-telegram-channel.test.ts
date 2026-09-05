/**
 * Production-path proof: loopback MCP ask_user reaches Telegram Bot API, then
 * completes after the shared question bridge answers.
 *
 * Lives under test/ so core gateway tests do not import the Telegram plugin.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../src/agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../src/agents/cli-runner.test-helpers.js";
import { prepareCliRunContext } from "../src/agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../src/agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../src/agents/cli-runner/types.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../src/agents/harness/gateway-question.js";
import { withQuestionGateway } from "../src/agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../src/agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../src/auto-reply/reply/reply-run-registry.contracts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { resolveMcpLoopbackClientGrant } from "../src/gateway/mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import * as toolResolution from "../src/gateway/tool-resolution.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

vi.mock("../src/plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../src/tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionKey = "agent:main:telegram:direct:1";
const captureKey = "loopback-ask-user-telegram";
const questionArgs = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Which destination should be used?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};
const caller: ReplyToolAuthorityOverlay = {
  messageProvider: "telegram",
  senderIsOwner: true,
  toolsAllow: ["ask_user"],
  disableTools: false,
  traceAuthorized: false,
};

type McpResponse = {
  result: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};

type TelegramAskUserLoopback = {
  apiRoot: string;
  requests: Array<{ body: string; method: string | undefined; url: string }>;
  close: () => Promise<void>;
};

async function startTelegramAskUserLoopback(): Promise<TelegramAskUserLoopback> {
  const requests: TelegramAskUserLoopback["requests"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url ?? "",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: requests.length,
            date: 1_700_000_000,
            chat: { id: 1, type: "private" },
            text: "ok",
          },
        }),
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
      },
    ],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    loadManifestModelCatalog: () => [],
  });
});

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

describe("loopback ask_user Telegram channel transport", () => {
  it("publishes the prompt through Bot API and completes after the answer", async () => {
    const { telegramPlugin } = await import("../extensions/telegram/api.js");
    const telegram = await startTelegramAskUserLoopback();
    try {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      );
      const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
      const { dir } = cli.session;
      await runQaGatewayFixture(
        async () =>
          await withQuestionGateway(async (gateway) => {
            const config: OpenClawConfig = {
              ...expectDefined(getRuntimeConfigSnapshot(), "isolated question gateway config"),
              agents: { defaults: { workspace: dir }, entries: { main: { default: true } } },
              plugins: { enabled: false },
              tools: { profile: "full" },
              channels: {
                telegram: {
                  botToken: "123456:loopback-ask-user",
                  apiRoot: telegram.apiRoot,
                },
              },
            };
            setRuntimeConfigSnapshot(config);
            const server = await ensureMcpLoopbackServer();
            const { getActiveMcpLoopbackRuntime } =
              await import("../src/gateway/mcp-http.loopback-runtime.js");
            const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "loopback runtime");
            const toolCalls = new Set<Promise<unknown>>();
            const resolveTools = toolResolution.resolveGatewayScopedTools;
            const resolutions = vi
              .spyOn(toolResolution, "resolveGatewayScopedTools")
              .mockImplementation((...args) => {
                const scoped = resolveTools(...args);
                for (const tool of scoped.tools) {
                  const execute = tool.execute;
                  vi.spyOn(tool, "execute").mockImplementation(async (...executeArgs) => {
                    const pending = execute(...executeArgs);
                    toolCalls.add(pending);
                    try {
                      return await pending;
                    } finally {
                      toolCalls.delete(pending);
                    }
                  });
                }
                return scoped;
              });
            const requestController = new AbortController();
            const contexts: PreparedCliRunContext[] = [];
            const admissions: PreparedAgentRunAdmission[] = [];
            const requests: Promise<McpResponse>[] = [];
            const persist = vi.fn(async () => {});
            const request = async (token: string, method: "tools/list" | "tools/call") => {
              const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
                method: "POST",
                signal: requestController.signal,
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                  "x-openclaw-cli-capture-key": captureKey,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  ...(method === "tools/call"
                    ? { params: { name: "ask_user", arguments: questionArgs } }
                    : {}),
                }),
              });
              expect(response.status).toBe(200);
              return (await response.json()) as McpResponse;
            };
            await runQaGatewayFixture(
              async () => {
                const source = new AbortController();
                const admission = prepareAgentRunAdmission({
                  cfg: config,
                  facts: {
                    runId: "loopback-ask-user-telegram",
                    agentId: "main",
                    ingress: { kind: "system", boundary: "mcp-question-test", state: "present" },
                  },
                  operationalRunInstance: createOperationalRunInstanceRef(
                    "loopback-ask-user-telegram",
                  ),
                });
                admissions.push(admission);
                const context = await cli.prepare({
                  config,
                  preparedRunAdmission: admission,
                  sessionKey,
                  runId: "loopback-ask-user-telegram",
                  timeoutMs: 60_000,
                  abortSignal: source.signal,
                  messageProvider: "telegram",
                  currentChannelId: "1",
                  agentAccountId: "default",
                  senderIsOwner: true,
                  toolsAllow: ["ask_user"],
                });
                contexts.push(context);
                const token = expectDefined(
                  context.preparedBackend.env?.OPENCLAW_MCP_TOKEN,
                  "prepared CLI grant",
                );
                context.preparedBackend.mcpClientGrantCapture?.activate(captureKey);
                expect(
                  resolveMcpLoopbackClientGrant({
                    token,
                    runtimeOwnerToken: runtime.ownerToken,
                    captureKey,
                  })?.isCurrent(),
                ).toBe(true);
                await request(token, "tools/list");
                const registration = gateway.holdRegistration();
                const response = request(token, "tools/call");
                requests.push(response);
                void response.catch(() => {});
                try {
                  await Promise.race([
                    registration.entered,
                    response.then(() => {
                      throw new Error("ask_user completed before question registration");
                    }),
                  ]);
                } finally {
                  registration.release();
                }
                await expect
                  .poll(() =>
                    telegram.requests.filter((entry) => entry.url.includes("sendMessage")),
                  )
                  .toHaveLength(1);
                const prompt = expectDefined(
                  telegram.requests.find((entry) => entry.url.includes("sendMessage")),
                  "Telegram sendMessage",
                );
                expect(prompt.body).toContain("Which destination should be used?");
                expect(prompt.body).toContain("Staging");
                await expect(
                  claimPendingAgentQuestionAnswerFromCaller({
                    sessionKey,
                    text: "Staging",
                    caller,
                    persist,
                    assertSourceCurrent: () => {},
                  }),
                ).resolves.toBe(true);
                const completed = await response;
                expect(completed.result.isError).toBe(false);
                expect(completed.result.content).toEqual([
                  expect.objectContaining({
                    type: "text",
                    text: expect.stringContaining('"status": "answered"'),
                  }),
                ]);
              },
              () => {
                requestController.abort();
                for (const question of gateway.manager.list()) {
                  gateway.manager.cancel(question.id, "test-cleanup");
                }
              },
              () => Promise.allSettled(requests),
              () => server.close(),
              () => Promise.allSettled(toolCalls),
              () =>
                runQaGatewayFixture(
                  async () => {},
                  ...contexts.map((context) => () => context.preparedBackend.cleanup?.()),
                  ...admissions.map((admission) => () => admission.close()),
                ),
              () => resolutions.mockRestore(),
            );
          }),
        () => closeOpenClawStateDatabaseForTest(),
        () => cli.cleanup(),
      );
    } finally {
      await telegram.close();
    }
  });
});
