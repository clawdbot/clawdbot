import { afterEach, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
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
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";
import { installSessionPlacementAdmissionProvider } from "../../session-placement-admission.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: ({
    provider,
    modelId,
    preparedAuthPlan,
  }: {
    provider: string;
    modelId: string;
    preparedAuthPlan: unknown;
  }) => ({ resolvedRef: { provider, modelId }, auth: preparedAuthPlan }),
}));

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

it.each([
  { agentId: "main", sandboxSessionKey: undefined, remoteSkills: false, oneShotCliRun: undefined },
  { agentId: "work", sandboxSessionKey: "global", remoteSkills: false, oneShotCliRun: true },
  {
    agentId: "work",
    sandboxSessionKey: "agent:main:policy",
    remoteSkills: false,
    oneShotCliRun: false,
  },
  { agentId: "main", sandboxSessionKey: undefined, remoteSkills: true, oneShotCliRun: true },
])(
  "dispatches the generic harness for $agentId/global with policy $sandboxSessionKey, remote skills $remoteSkills, and one-shot $oneShotCliRun",
  async ({ agentId, sandboxSessionKey, remoteSkills, oneShotCliRun }) => {
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
      const runtimePluginToolGrant = { pluginId: "owner-tools", toolNames: ["owner_only"] };
      const params = {
        admittedRunContext,
        agentId,
        config,
        runId,
        sessionId: `${agentId}-global`,
        sessionKey: "global",
        sandboxSessionKey,
        workspaceDir: state.workspaceDir,
        sessionFile: "global",
        prompt: remoteSkills ? "Use the skill at /host/skills/demo/SKILL.md." : "hello",
        ...(remoteSkills
          ? {
              explicitSkillSelections: [
                { name: "demo", path: "/host/skills/demo/SKILL.md" },
                { name: "native", path: "node://worker/skills/native/SKILL.md" },
              ],
            }
          : {}),
        timeoutMs: 5_000,
        oneShotCliRun,
        runtimePluginToolGrant,
      };
      let lifecycleGeneration = getAgentEventLifecycleGeneration();
      const laneController = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => lifecycleGeneration,
        getParams: () => params,
        globalLane: "owner-dispatch-global",
        sessionLane: "owner-dispatch-session",
        initialQueuedLifecycleGeneration: lifecycleGeneration,
        setLifecycleGeneration: (value) => {
          lifecycleGeneration = value;
        },
        setParams: () => {},
      });
      const authProfileStore = { version: 1, profiles: {} };
      const input = {
        runInput: {
          runParams: params,
          provider: "fixture",
          modelId: "fixture-model",
          workspaceResolution: { agentId, workspaceDir: state.workspaceDir },
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(agentId),
          isCanonicalWorkspace: true,
          resolvedSessionKey: "global",
          resolvedToolResultFormat: "markdown",
          startedAtMs: Date.now(),
          startupStages: { mark: vi.fn() },
          emitStartupStageSummary: vi.fn(),
          lifecycleGeneration,
          laneController,
          progressController: {
            resolveAttemptFastModeParam: () => false,
            maybeAnnounceFastModeAutoOff: vi.fn(),
            notifyExecutionPhase: vi.fn(),
            notifyRunProgress: vi.fn(),
            notifyToolResult: vi.fn(),
            notifyAgentEvent: vi.fn(),
          },
        },
        preparedRuntime: {
          requestedModelId: "fixture-model",
          nativeModelOwned: true,
          attemptAuthProfileStore: authProfileStore,
          resolveRunAttemptAuthProfileStore: () => authProfileStore,
          snapshot: () => ({
            agentHarness: { id: "owner-fixture" },
            pluginHarnessOwnsTransport: true,
            effectiveModel: {
              id: "fixture-model",
              provider: "fixture",
              api: "openai-responses",
              input: ["text"],
            },
            thinkLevel: "off",
            apiKeyInfo: null,
            runtimeAuthState: null,
            activePreparedAuthPlan: {
              providerForAuth: "fixture",
              authProfileProviderForAuth: "fixture",
            },
            providerRuntimeHandle: { provider: "fixture" },
          }),
        },
        sessionPromptState: {
          sessionId: `${agentId}-global`,
          sessionFile: "global",
          sessionTarget: { agentId, sessionId: `${agentId}-global`, sessionKey: "global" },
          activePrompt: { persisted: false, internal: false },
          onUserMessagePersisted: vi.fn(),
          settleOwnedTranscriptProjection: vi.fn(),
          suppressNextUserMessagePersistence: false,
        },
        terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
        provider: "fixture",
        modelId: "fixture-model",
        replayState: { replayInvalid: false, hadPotentialSideEffects: false },
        startupStagesEmitted: false,
        bootstrapPromptWarningSignaturesSeen: [],
        resolveRuntimeFallbackReason: () => null,
        observeToolOutcome: vi.fn(),
        isTurnTainted: () => false,
        allocateToolOutcomeOrdinal: () => 1,
        getPostCompactionAbortError: () => undefined,
        setPostCompactionAbortController() {},
        clearPostCompactionAbortController() {},
      } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];
      const remoteSandbox = remoteSkills
        ? createSandboxTestContext({
            overrides: {
              workspaceDir: state.workspaceDir,
              agentWorkspaceDir: state.workspaceDir,
              readOnlyResourceMounts: [
                { hostPath: "/host/skills/demo", containerPath: "/remote/inbound/0" },
              ],
            },
          })
        : null;
      const sandboxProvider = { resolveSandbox: async () => remoteSandbox };
      const restorePlacement = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed() {},
        executeLocalTurn: async (_claim, runLocal) => runLocal(),
        executeTurn: async (_claim, _params, runLocal) => runLocal(),
        ...sandboxProvider,
      });
      try {
        const { dispatchedAttempt: result } = await prepareAndDispatchEmbeddedRunAttempt(input);
        expect(result.rawAttempt.terminal).toEqual({ kind: "ok" });
        expect(result.rawAttempt.assistantTexts).toEqual([`${agentId} answered`]);
        expect(runAttempt).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ agentId, sessionKey: "global", sandboxSessionKey }),
        );
        expect.soft(runAttempt.mock.calls[0]?.[0].oneShotCliRun).toBe(oneShotCliRun);
        expect
          .soft(runAttempt.mock.calls[0]?.[0].runtimePluginToolGrant)
          .toBe(runtimePluginToolGrant);
        const sandbox = runAttempt.mock.calls[0]?.[0].sandbox;
        if (remoteSkills) {
          const dispatched = runAttempt.mock.calls[0]?.[0];
          expect(dispatched?.prompt).toBe("Use the skill at /remote/inbound/0/SKILL.md.");
          expect(dispatched?.explicitSkillSelections).toEqual([
            { name: "demo", path: "/remote/inbound/0/SKILL.md" },
            { name: "native", path: "node://worker/skills/native/SKILL.md" },
          ]);
          expect(params.explicitSkillSelections?.[0]?.path).toBe("/host/skills/demo/SKILL.md");
          expect(sandbox).toEqual(remoteSandbox);
        } else if (agentId === "work" && sandboxSessionKey === "global") {
          expect(provisioned).toHaveLength(1);
          expect(provisioned[0]).toMatch(/^agent:work:workspace:/);
          expect(sandbox?.runtimeId).toBe(provisioned[0]);
          expect(sandbox?.workspaceDir.startsWith(state.path("sandbox"))).toBe(true);
        } else {
          expect(provisioned).toEqual([]);
          expect(sandbox).toBeNull();
        }
      } finally {
        restorePlacement();
        admission.close();
        restoreSandbox();
      }
    });
  },
);
