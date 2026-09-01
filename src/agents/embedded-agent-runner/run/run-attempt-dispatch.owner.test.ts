import { afterEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { registerAgentHarness } from "../../harness/registry.js";
import type { AgentHarness } from "../../harness/types.js";
import { registerSandboxBackend } from "../../sandbox/backend.js";
import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

it.each([
  { agentId: "main", sandboxSessionKey: undefined },
  { agentId: "work", sandboxSessionKey: "global" },
  { agentId: "work", sandboxSessionKey: "agent:main:policy" },
])(
  "dispatches the generic harness for $agentId/global with policy $sandboxSessionKey",
  async ({ agentId, sandboxSessionKey }) => {
    await withOpenClawTestState({ label: "harness-owner" }, async (state) => {
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: { sandbox: { mode: "all" as const } } },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode: "off" as const,
              backend: "owner-fixture",
              scope: "agent" as const,
              workspaceRoot: state.path("sandbox"),
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
        session: { scope: "global" as const },
      };
      const provisioned: string[] = [];
      const restoreSandbox = registerSandboxBackend("owner-fixture", async ({ scopeKey }) => {
        provisioned.push(scopeKey);
        return {
          id: "owner-fixture",
          runtimeId: scopeKey,
          runtimeLabel: "Synthetic sandbox",
          workdir: "/workspace",
          buildExecSpec: async () => {
            throw new Error("unexpected exec");
          },
          runShellCommand: async () => {
            throw new Error("unexpected shell command");
          },
        };
      });
      const runId = `dispatch-${agentId}`;
      const admission = prepareAgentRunAdmission({
        cfg: config,
        facts: {
          runId,
          agentId,
          ingress: { kind: "system", boundary: "owner-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("plugin-harness", "owner-test");
      setActivePluginRegistry(createEmptyPluginRegistry());
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (params) => ({
        terminal: { kind: "ok" },
        sessionIdUsed: params.sessionId,
        messagesSnapshot: [],
        assistantTexts: [`${params.agentId} answered`],
        toolMetas: [],
        lastAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      }));
      registerAgentHarness({
        id: "owner-fixture",
        label: "Owner fixture",
        supports: () => ({ supported: true }),
        conversationToolPolicySupport: "exact",
        runAttempt,
      });
      const input = {
        params: {
          admittedRunContext,
          agentId,
          config,
          runId,
          sessionId: `${agentId}-global`,
          sessionKey: "global",
          sandboxSessionKey,
          workspaceDir: state.workspaceDir,
          sessionFile: "global",
          prompt: "hello",
          timeoutMs: 5_000,
        },
        runtime: {
          agentId,
          sessionId: `${agentId}-global`,
          sessionKey: "global",
          sessionFile: "global",
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(agentId),
          isCanonicalWorkspace: true,
          prompt: "hello",
          provider: "fixture",
          modelId: "fixture-model",
          requestedModelId: "fixture-model",
          fallbackActive: false,
          fallbackReason: null,
          agentHarnessId: "owner-fixture",
          model: {
            id: "fixture-model",
            provider: "fixture",
            api: "openai-responses",
            input: ["text"],
          },
          authProfileIdSource: "auto",
          initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
          authProfileStore: { version: 1, profiles: {} },
          thinkLevel: "off",
          fastMode: false,
          toolResultFormat: "markdown",
          skipPreparedUserTurnMessage: false,
          apiKeyInfo: null,
          runtimeAuthActive: false,
          captureRuntimeArtifact: false,
        },
        control: {
          pluginHarnessOwnsTransport: true,
          laneTaskAbortController: new AbortController(),
          laneTaskReleaseController: new AbortController(),
          noteLaneTaskProgress() {},
          getPostCompactionAbortError: () => undefined,
          setPostCompactionAbortController() {},
          clearPostCompactionAbortController() {},
        },
        transcriptOwnership: { kind: "runtime-target" },
        runStartedAtMs: Date.now(),
        bootstrapPromptWarningSignaturesSeen: [],
        suppressNextUserMessagePersistence: false,
        beforeAgentFinalizeRevisionAttempts: 0,
        maxBeforeAgentFinalizeRevisions: 0,
      } as unknown as Parameters<typeof dispatchEmbeddedRunAttempt>[0];
      try {
        const result = await dispatchEmbeddedRunAttempt(input);
        expect(result.rawAttempt.terminal).toEqual({ kind: "ok" });
        expect(result.rawAttempt.assistantTexts).toEqual([`${agentId} answered`]);
        expect(runAttempt).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ agentId, sessionKey: "global", sandboxSessionKey }),
        );
        const sandbox = runAttempt.mock.calls[0]?.[0].sandbox;
        if (agentId === "work" && sandboxSessionKey === "global") {
          expect(provisioned).toHaveLength(1);
          expect(provisioned[0]).toMatch(/^agent:work:workspace:/);
          expect(sandbox?.runtimeId).toBe(provisioned[0]);
          expect(sandbox?.workspaceDir.startsWith(state.path("sandbox"))).toBe(true);
        } else {
          expect(provisioned).toEqual([]);
          expect(sandbox).toBeNull();
        }
      } finally {
        admission.close();
        restoreSandbox();
      }
    });
  },
);
