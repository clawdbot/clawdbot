import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { loadBundledPluginPublicSurface } from "../../plugin-sdk/test-helpers/public-surface-loader.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { withSessionPlacementComputer } from "../session-placement-computer.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";
import type { ComputerToolTransport } from "../tools/computer-tool.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import type { AgentHarnessAttemptParamsV2, AgentHarnessV2 } from "./types.js";

// The real SDK launches this synthetic peer via its documented COPILOT_CLI_PATH
// override. Only CLI protocol effects are controlled; no SDK object is impersonated.
const CLI_FIXTURE = String.raw`
const { randomUUID } = require("node:crypto");
let sessionId;
let hasComputer = false;
let previousEventId = null;
let buffer = Buffer.alloc(0);
const send = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  process.stdout.write("Content-Length: " + bytes.length + "\r\n\r\n");
  process.stdout.write(bytes);
};
const emit = (type, data) => {
  const id = randomUUID();
  send({ jsonrpc: "2.0", method: "session.event", params: {
    sessionId, event: { id, parentId: previousEventId, timestamp: new Date().toISOString(), type, data },
  }});
  previousEventId = id;
};
const fail = (message) => emit("session.error", { message, errorType: "model_error" });
const handle = ({ id, method, params }) => {
  let result = {};
  switch (method) {
    case "connect": result = { protocolVersion: 3 }; break;
    case "session.create":
      sessionId = params.sessionId;
      hasComputer = params.tools?.some((tool) => tool.name === "computer") === true;
      result = { sessionId };
      break;
    case "session.send":
      send({ jsonrpc: "2.0", id, result: { messageId: "fixture-user" } });
      emit("user.message", { content: params.prompt });
      if (!hasComputer) {
        fail("placed computer missing from SDK tool surface");
        return;
      }
      emit("external_tool.requested", {
        requestId: "fixture-computer", toolCallId: "fixture-computer",
        toolName: "computer", arguments: { action: "screenshot" },
      });
      return;
    case "session.tools.handlePendingToolCall":
      fail(params.result?.resultType === "success"
        ? "synthetic provider failure"
        : "synthetic computer call failed: " + JSON.stringify(params));
      break;
    case "session.abort": fail("synthetic abort"); break;
    case "session.destroy": break;
    case "runtime.shutdown":
      send({ jsonrpc: "2.0", id, result });
      process.stdin.destroy();
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Unexpected fixture RPC: " + method } });
      return;
  }
  send({ jsonrpc: "2.0", id, result });
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1]);
    if (buffer.length < separator + 4 + length) return;
    const request = JSON.parse(buffer.subarray(separator + 4, separator + 4 + length).toString());
    buffer = buffer.subarray(separator + 4 + length);
    handle(request);
  }
});
`;

it.each([false, true])(
  "public Copilot harness owns placed computer execution and cleanup (close fails: %s)",
  async (closeFails) =>
    withOpenClawTestState(
      {
        label: "copilot-computer-lifecycle",
        env: { COPILOT_CLI_PATH: undefined, COPILOT_SDK_DEFAULT_CONNECTION: "stdio" },
      },
      async (state) => {
        state.envVars.COPILOT_CLI_PATH = await state.writeText(
          "copilot-protocol-fixture.js",
          CLI_FIXTURE,
        );
        state.applyEnv();
        const { createCopilotAgentHarness } = await loadBundledPluginPublicSurface<{
          createCopilotAgentHarness: () => AgentHarnessV2;
        }>({ pluginId: "copilot", artifactBasename: "harness.js" });
        const harness = createCopilotAgentHarness();
        const controller = new AbortController();
        const closeStarted = createDeferred();
        const releaseClose = createDeferred();
        const calls: Parameters<ComputerToolTransport["invoke"]>[0][] = [];
        const observed: Array<{ toolName: string; result: unknown; isError?: boolean }> = [];
        let retainedComputer: AnyAgentTool | undefined;
        const runId = "copilot-computer-run";
        const sessionId = "copilot-computer-session";
        const sessionKey = "agent:main:copilot-computer";
        const config = { plugins: { enabled: false }, tools: { codeMode: { enabled: false } } };
        const host = await createAdmittedHostCapabilityTestFixture({
          agentId: "main",
          runId,
          sessionId,
          sessionKey,
          config,
          workspaceDir: state.workspaceDir,
          abortSignal: controller.signal,
        });
        const transport = {
          computerUse: {
            contractVersion: 2,
            provider: { id: "fixture", label: "Synthetic desktop", generation: "generation-1" },
            actions: ["screenshot"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          },
          resolveNode: async () => ({ nodeId: "synthetic-desktop" }),
          invoke: async (request) => {
            calls.push(request);
            if (request.command === "screen.snapshot") {
              return {
                format: "png",
                width: 1,
                height: 1,
                screenIndex: 0,
                displayFrameId: "synthetic-frame",
                base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
              };
            }
            closeStarted.resolve();
            await releaseClose.promise;
            if (closeFails) {
              throw new Error("synthetic native close failure");
            }
            return { ok: true };
          },
        } satisfies ComputerToolTransport;
        let attempt: ReturnType<typeof harness.runAttempt> | undefined;
        let settled = false;
        try {
          await state.writeConfig(config);
          const target = {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          };
          await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
          const authStorage = AuthStorage.inMemory();
          const message = {
            role: "user" as const,
            content: "Observe the synthetic desktop.",
            timestamp: Date.now(),
          };
          let persisted = false;
          let blocked = false;
          const params = {
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            sessionId,
            sessionKey,
            sessionTarget: target,
            sessionFile: path.join(state.sessionsDir(), "copilot.jsonl"),
            runId,
            config,
            hostCapabilities: {
              ...host.hostCapabilities,
              createToolSurface: (options, binding) => {
                const tools = expectDefined(
                  host.hostCapabilities.createToolSurface,
                  "real host constructor",
                )(options, binding);
                retainedComputer = tools.find((tool) => tool.name === "computer");
                return tools;
              },
            },
            onAgentToolResult: (event) => {
              observed.push(event);
            },
            abortSignal: controller.signal,
            auth: { useLoggedInUser: true },
            provider: "github-copilot",
            modelId: "auto",
            model: {
              api: "openai-responses",
              provider: "github-copilot",
              id: "auto",
              name: "Synthetic protocol fixture",
              baseUrl: "http://127.0.0.1",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            authStorage,
            authProfileStore: { version: 1, profiles: {} },
            modelRegistry: ModelRegistry.inMemory(authStorage),
            thinkLevel: "off",
            prompt: message.content,
            timeoutMs: 60_000,
            userTurnTranscriptRecorder: {
              message,
              resolveMessage: async () => message,
              markRuntimePersistencePending: () => {},
              markRuntimePersisted: () => {
                persisted = true;
              },
              markBlocked: () => {
                blocked = true;
              },
              hasPersisted: () => persisted,
              isBlocked: () => blocked,
              hasRuntimePersistencePending: () => false,
              getAdmissionReceipt: () => undefined,
              waitForRuntimePersistence: async () => {},
              persistApproved: async () => {},
              persistBlocked: async () => {},
              persistFallback: async () => {},
            },
          } satisfies AgentHarnessAttemptParamsV2 & { auth: { useLoggedInUser: true } };
          attempt = withSessionPlacementComputer(
            {
              runId,
              agentId: "main",
              isActive: () => !controller.signal.aborted,
              computerUse: transport.computerUse,
              bind: (run) => {
                expect(run).toBe(host.admittedRunContext.operationalRunInstance);
                return transport;
              },
            },
            () => harness.runAttempt(params),
          ).finally(() => {
            settled = true;
          });
          await Promise.race([
            closeStarted.promise,
            attempt.then((result) => {
              if (!("terminal" in result) || result.terminal.kind !== "failed") {
                throw new Error("Attempt ended before placed computer cleanup", { cause: result });
              }
              throw new Error(
                `Attempt ended before placed computer cleanup: ${formatErrorMessage(result.terminal.error)}`,
                { cause: result.terminal.error },
              );
            }),
          ]);
          expect(observed).toEqual([
            expect.objectContaining({ toolName: "computer", isError: false }),
          ]);
          expect(calls).toHaveLength(2);
          expect(calls[0]?.command).toBe("screen.snapshot");
          expect(settled).toBe(false);
          host.hostCapabilities.assertActive();
          expect(controller.signal.aborted).toBe(false);
          expect(calls[1]).toMatchObject({
            nodeId: "synthetic-desktop",
            command: "computer.act",
            commandParams: {
              action: "__close_execution",
              executionId: calls[0]?.commandParams.executionId,
              reason: "error",
            },
          });
          expect(calls[1]?.signal).toBeUndefined();
          releaseClose.resolve();
          const result = await attempt;
          if (!("terminal" in result)) {
            throw new Error("Expected a canonical Copilot attempt terminal");
          }
          expect(result.terminal.kind).toBe("failed");
          if (result.terminal.kind !== "failed") {
            throw new Error("Expected provider failure");
          }
          const failure = formatErrorMessage(result.terminal.error);
          expect(failure).toContain("synthetic provider failure");
          if (closeFails) {
            expect(failure).toContain("synthetic native close failure");
            expect(result.replayMetadata?.replaySafe).toBe(false);
          }
          expect(calls).toHaveLength(2);
          host.closeHost();
          await expect(
            expectDefined(retainedComputer, "real host-bound computer").execute("retained-call", {
              action: "screenshot",
            }),
          ).rejects.toThrow(/no longer active/);
          expect(calls).toHaveLength(2);
        } finally {
          releaseClose.resolve();
          controller.abort();
          try {
            await attempt;
          } finally {
            host.closeHost();
            host.closeAdmission();
            await harness.dispose?.();
          }
        }
      },
    ),
);
