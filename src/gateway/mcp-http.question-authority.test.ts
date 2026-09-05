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
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../agents/cli-runner.test-helpers.js";
import { prepareCliRunContext } from "../agents/cli-runner/prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../agents/harness/gateway-question.js";
import { withQuestionGateway } from "../agents/harness/gateway-question.test-support.js";
import { resetPendingAskUserQuestionsForTest } from "../agents/tools/ask-user-tool.test-support.js";
import type { ReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  deactivateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  resolveMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "./mcp-http.js";
import * as toolResolution from "./tool-resolution.js";

vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const sessionKey = "agent:main:main";
const telegramSessionKey = "agent:main:telegram:direct:1";
const captureKey = "question-capture";
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
  messageProvider: "webchat",
  senderIsOwner: true,
  toolsAllow: ["ask_user"],
  disableTools: false,
  traceAuthorized: false,
};
let nativeToolProjector: ((tools: readonly string[]) => readonly string[]) | undefined;

type McpResponse = {
  result: {
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
};

beforeEach(() => {
  nativeToolProjector = undefined;
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...buildDefaultTestCliBackend({ bundleMcp: true }),
        autoSelectAuthProfile: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
        projectNativeToolAuthority: nativeToolProjector,
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

type QuestionLoopbackOptions = {
  sessionKey?: string;
  messageProvider?: string;
  currentChannelId?: string;
  agentAccountId?: string;
  config?: OpenClawConfig;
};

async function withCliQuestionLoopback(
  run: (fixture: {
    prepare: (
      runId?: string,
      target?: { sessionKey?: string },
    ) => Promise<{
      token: string;
      context: PreparedCliRunContext;
      source: AbortController;
      admission: PreparedAgentRunAdmission;
      originalToolsAllow: string[];
    }>;
    list: (token: string, attached?: boolean) => Promise<McpResponse>;
    ask: (
      token: string,
      attached?: boolean,
    ) => Promise<{
      id: string;
      response: Promise<McpResponse>;
    }>;
    answer: (overlay?: ReplyToolAuthorityOverlay) => Promise<boolean>;
    retire: (id: string) => void;
    manager: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["manager"];
    holdNextHello: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["holdNextHello"];
    runtimeOwnerToken: string;
    resolutionCount: () => number;
    resolveRequestCount: () => number;
    persist: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  options?: QuestionLoopbackOptions,
) {
  const activeSessionKey = options?.sessionKey ?? sessionKey;
  const cli = createCliRunnerPrepareFixture(prepareCliRunContext);
  const { dir } = cli.session;
  await runQaGatewayFixture(
    async () =>
      await withQuestionGateway(async (gateway) => {
        const config: OpenClawConfig = {
          ...expectDefined(getRuntimeConfigSnapshot(), "isolated question gateway config"),
          ...options?.config,
          agents: { defaults: { workspace: dir }, entries: { main: { default: true } } },
          plugins: { enabled: false },
          tools: { profile: "full" },
        };
        // Config identity is stable: tools/list must seed the same cache used by tools/call.
        setRuntimeConfigSnapshot(config);
        const server = await ensureMcpLoopbackServer();
        const { getActiveMcpLoopbackRuntime } = await import("./mcp-http.loopback-runtime.js");
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
        const request = async (
          token: string,
          method: "tools/list" | "tools/call",
          attached = false,
        ) => {
          const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method: "POST",
            signal: requestController.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...(attached ? {} : { "x-openclaw-cli-capture-key": captureKey }),
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
            await run({
              prepare: async (
                runId = "mcp-question-run",
                target = { sessionKey: activeSessionKey },
              ) => {
                const source = new AbortController();
                const admission = prepareAgentRunAdmission({
                  cfg: config,
                  facts: {
                    runId,
                    agentId: "main",
                    ingress: { kind: "system", boundary: "mcp-question-test", state: "present" },
                  },
                  operationalRunInstance: createOperationalRunInstanceRef(runId),
                });
                admissions.push(admission);
                const originalToolsAllow = ["ask_user"];
                const context = await cli.prepare({
                  config,
                  preparedRunAdmission: admission,
                  sessionKey: target.sessionKey,
                  runId,
                  timeoutMs: 60_000,
                  abortSignal: source.signal,
                  messageProvider: options?.messageProvider ?? "webchat",
                  currentChannelId: options?.currentChannelId,
                  agentAccountId: options?.agentAccountId,
                  senderIsOwner: true,
                  toolsAllow: originalToolsAllow,
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
                return { token, context, source, admission, originalToolsAllow };
              },
              list: (token, attached) => request(token, "tools/list", attached),
              ask: async (token, attached) => {
                const registration = gateway.holdRegistration();
                const response = request(token, "tools/call", attached);
                requests.push(response);
                void response.catch(() => {});
                try {
                  await Promise.race([
                    registration.entered,
                    response.then(() => {
                      throw new Error("ask_user completed before question registration");
                    }),
                  ]);
                  expect(gateway.manager.list()).toHaveLength(1);
                  const question = expectDefined(
                    gateway.manager.list()[0],
                    "registered ask_user question",
                  );
                  return { id: question.id, response };
                } finally {
                  registration.release();
                }
              },
              answer: (overlay = caller) =>
                claimPendingAgentQuestionAnswerFromCaller({
                  sessionKey: activeSessionKey,
                  text: "Staging",
                  caller: overlay,
                  persist,
                  assertSourceCurrent: () => {},
                }),
              retire: (id) => gateway.manager.cancel(id, "test-cleanup"),
              manager: gateway.manager,
              holdNextHello: gateway.holdNextHello,
              runtimeOwnerToken: runtime.ownerToken,
              resolutionCount: () => resolutions.mock.calls.length,
              resolveRequestCount: () =>
                gateway.requests.filter((frame) => frame.method === "question.resolve").length,
              persist,
            });
          },
          () => {
            // Acquisition can fail before registration. Abort that transport first,
            // then join tool cancellation RPCs before the question Gateway is reset.
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
}

function expectAnswered(response: McpResponse) {
  expect(response.result.isError).toBe(false);
  expect(response.result.content).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining('"status": "answered"'),
    }),
  ]);
}

describe("CLI loopback question creator authority", () => {
  it("publishes a Telegram-originated ask_user prompt through Bot API and completes after the answer", async () => {
    const { telegramPlugin } = await import("../../extensions/telegram/api.js");
    const telegram = await startTelegramAskUserLoopback();
    try {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      );
      await withCliQuestionLoopback(
        async (fixture) => {
          const owner = await fixture.prepare();
          await fixture.list(owner.token);
          const question = await fixture.ask(owner.token);
          await expect
            .poll(() => telegram.requests.filter((request) => request.url.includes("sendMessage")))
            .toHaveLength(1);
          const prompt = expectDefined(
            telegram.requests.find((request) => request.url.includes("sendMessage")),
            "Telegram sendMessage",
          );
          expect(prompt.body).toContain("Which destination should be used?");
          expect(prompt.body).toContain("Staging");
          await expect(fixture.answer()).resolves.toBe(true);
          expectAnswered(await question.response);
        },
        {
          sessionKey: telegramSessionKey,
          messageProvider: "telegram",
          currentChannelId: "1",
          agentAccountId: "default",
          config: {
            channels: {
              telegram: {
                botToken: "123456:loopback-ask-user",
                apiRoot: telegram.apiRoot,
              },
            },
          },
        },
      );
    } finally {
      await telegram.close();
    }
  });

  it("answers a real cached ask_user with the CLI creator's original frozen policy", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const owner = await fixture.prepare();
      const beforeList = fixture.resolutionCount();
      expect((await fixture.list(owner.token)).result.tools?.map((tool) => tool.name)).toEqual([
        "ask_user",
      ]);
      await fixture.list(owner.token);
      expect(fixture.resolutionCount()).toBe(beforeList + 1);
      owner.originalToolsAllow.push("exec");
      const question = await fixture.ask(owner.token);
      expect(fixture.resolutionCount()).toBe(beforeList + 1);

      await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
      expect(fixture.persist).not.toHaveBeenCalled();
      expect(fixture.manager.get(question.id)?.status).toBe("pending");
      await expect(fixture.answer()).resolves.toBe(true);
      expect(fixture.persist).toHaveBeenCalledOnce();
      expect(fixture.resolveRequestCount()).toBe(1);
      expectAnswered(await question.response);
    });
  });

  it.each([
    { name: "explicit main alias", supplied: "main", native: sessionKey },
    { name: "omitted session key", supplied: undefined, native: undefined },
  ])("binds the actual MCP registration target for $name", async ({ supplied, native }) => {
    await withCliQuestionLoopback(async (fixture) => {
      const owner = await fixture.prepare(undefined, { sessionKey: supplied });
      expect(owner.context.params.sessionKey).toBe(native);
      const grant = expectDefined(
        resolveMcpLoopbackClientGrant({
          token: owner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
          captureKey,
        }),
        "live CLI grant",
      );
      expect(grant.context.sessionKey).toBe(sessionKey);
      expect(grant.context).not.toHaveProperty("bindQuestionAnswerAuthority");
      const nativeAuthority = expectDefined(
        owner.context.bindQuestionAnswerAuthority,
        "native question binder",
      )(() => {});
      expect(nativeAuthority.sessionKey).toBe(native ?? owner.context.params.sessionId);
      await fixture.list(owner.token);
      const question = await fixture.ask(owner.token);
      expect(fixture.manager.get(question.id)?.sessionKey).toBe(sessionKey);
      await expect(fixture.answer()).resolves.toBe(true);
      expectAnswered(await question.response);
    });
  });

  it.each(["revoke", "source-abort", "admission-close"] as const)(
    "refuses a pending CLI question after %s without consuming the answer",
    async (change) => {
      await withCliQuestionLoopback(async (fixture) => {
        const owner = await fixture.prepare();
        const question = await fixture.ask(owner.token);
        await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow(
          "caller policy",
        );
        if (change === "revoke") {
          revokeMcpLoopbackClientGrant(owner.token);
        } else if (change === "source-abort") {
          owner.source.abort(new Error("original CLI source aborted"));
          expect(
            resolveMcpLoopbackClientGrant({
              token: owner.token,
              runtimeOwnerToken: fixture.runtimeOwnerToken,
              captureKey,
            })?.isCurrent(),
          ).toBe(true);
        } else {
          owner.admission.close();
        }

        await expect(fixture.answer()).rejects.toThrow();
        expect(fixture.persist).not.toHaveBeenCalled();
        expect(fixture.resolveRequestCount()).toBe(0);
        expect(fixture.manager.get(question.id)?.status).toBe("pending");
        fixture.retire(question.id);
        await question.response;
      });
    },
  );

  it.each(["reactivate", "rebind", "deactivate-reactivate", "native-publication"] as const)(
    "rematerializes cached questions after same-token and same-capture %s",
    async (change) => {
      if (change === "native-publication") {
        nativeToolProjector = () => [];
      }
      await withCliQuestionLoopback(async (fixture) => {
        const owner = await fixture.prepare();
        const publishNative =
          change === "native-publication"
            ? expectDefined(
                owner.context.preparedBackend.mcpClientGrantCapture?.captureNativeTools,
                "native capture observer",
              )
            : undefined;
        publishNative?.([]);
        await fixture.list(owner.token);
        const cachedCount = fixture.resolutionCount();
        await fixture.list(owner.token);
        const old = await fixture.ask(owner.token);
        expect(fixture.resolutionCount()).toBe(cachedCount);
        await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow(
          "caller policy",
        );
        const binding = {
          token: owner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
          captureKey,
        };
        if (publishNative) {
          publishNative([]);
        } else if (change === "rebind") {
          expect(
            bindMcpLoopbackClientGrantAdmission({
              ...binding,
              admittedRunContext: expectDefined(
                owner.context.params.admittedRunContext,
                "CLI admission",
              ),
            }),
          ).toBe(true);
        } else {
          if (change === "deactivate-reactivate") {
            expect(deactivateMcpLoopbackClientGrantCapture(binding)).toBe(true);
          }
          expect(activateMcpLoopbackClientGrantCapture(binding)).toBeTruthy();
        }
        await expect(fixture.answer()).rejects.toThrow();
        expect(fixture.persist).not.toHaveBeenCalled();
        expect(fixture.resolveRequestCount()).toBe(0);
        fixture.retire(old.id);
        await old.response;

        await fixture.list(owner.token);
        expect(fixture.resolutionCount()).toBe(cachedCount + 1);
        const fresh = await fixture.ask(owner.token);
        expect(fixture.resolutionCount()).toBe(cachedCount + 1);
        await expect(fixture.answer()).resolves.toBe(true);
        expectAnswered(await fresh.response);
      });
    },
  );

  it("moves fresh creator authority onto a warm process token without reviving its old question", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const oldOwner = await fixture.prepare("same-correlated-run");
      await fixture.list(oldOwner.token);
      const old = await fixture.ask(oldOwner.token);
      await expect(fixture.answer({ ...caller, toolsAllow: [] })).rejects.toThrow("caller policy");
      const nextOwner = await fixture.prepare("same-correlated-run");
      expect(
        transferMcpLoopbackClientGrant({
          sourceToken: nextOwner.token,
          targetToken: oldOwner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
        }),
      ).toBe(true);
      expect(
        activateMcpLoopbackClientGrantCapture({
          token: oldOwner.token,
          runtimeOwnerToken: fixture.runtimeOwnerToken,
          captureKey,
        }),
      ).toBeTruthy();
      await expect(fixture.answer()).rejects.toThrow();
      expect(fixture.persist).not.toHaveBeenCalled();
      fixture.retire(old.id);
      await old.response;
      oldOwner.admission.close();

      const beforeList = fixture.resolutionCount();
      await fixture.list(oldOwner.token);
      expect(fixture.resolutionCount()).toBe(beforeList + 1);
      const fresh = await fixture.ask(oldOwner.token);
      await expect(fixture.answer()).resolves.toBe(true);
      expectAnswered(await fresh.response);
    });
  });

  it("joins a question request when the fixture fails before registration", async () => {
    const bodyFailed = createDeferred();
    const expectedError = new Error("fixture stopped before question registration");
    let disposed = false;
    let releaseHello = () => {};
    let asking: Promise<unknown> | undefined;
    let manager: Parameters<Parameters<typeof withQuestionGateway>[0]>[0]["manager"] | undefined;
    const run = withCliQuestionLoopback(async (fixture) => {
      manager = fixture.manager;
      const grant = mintAttachGrant({ sessionKey });
      const hello = fixture.holdNextHello();
      releaseHello = hello.release;
      try {
        asking = fixture.ask(grant.token, true);
        void asking.catch(() => {});
        await Promise.race([hello.entered, asking]);
        bodyFailed.resolve();
        throw expectedError;
      } finally {
        revokeAttachGrant(grant.token);
      }
    }).finally(() => {
      disposed = true;
    });
    void run.catch(() => {});
    await runQaGatewayFixture(
      async () => {
        await Promise.race([bodyFailed.promise, run]);
        await vi.waitFor(() => expect(disposed).toBe(true));
      },
      () => {
        // Release the real transport even on the pre-fix failure so this proof
        // cannot leave its late question waiting for the human-input deadline.
        releaseHello();
      },
      () => asking?.catch(() => {}),
      () => {
        for (const question of manager?.list() ?? []) {
          manager?.cancel(question.id, "test-cleanup");
        }
      },
      () => expect(run).rejects.toBe(expectedError),
    );
  });

  it("keeps attach questions answerable through structured controls without inventing a caller snapshot", async () => {
    await withCliQuestionLoopback(async (fixture) => {
      const grant = mintAttachGrant({ sessionKey });
      try {
        const question = await fixture.ask(grant.token, true);
        await expect(fixture.answer()).rejects.toThrow("no prepared creator authority");
        expect(fixture.persist).not.toHaveBeenCalled();
        expect(fixture.resolveRequestCount()).toBe(0);
        const { callGatewayTool } = await import("../agents/tools/gateway.js");
        await callGatewayTool(
          "question.resolve",
          {},
          {
            id: question.id,
            answers: { answers: { choice: ["Staging"] } },
            resolvedBy: "structured-control",
          },
        );
        expectAnswered(await question.response);
      } finally {
        revokeAttachGrant(grant.token);
      }
    });
  });
});
