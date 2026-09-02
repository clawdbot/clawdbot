// Covers delegated system-agent approval ownership and closure.

import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createSystemAgentTool } from "../../agents/tools/system-agent-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({ resolvePersistentApplyInference: vi.fn() }));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
}));
vi.mock("../../system-agent/transcript-store.js", () => transcriptStoreMocks);

afterEach(() => {
  resetAgentRunRegistryForTest();
});

async function resolveTestProposal(
  params: Parameters<typeof prepareDelegatedSystemAgentApproval>[0] & {
    proposal: NonNullable<
      ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>
    >;
  },
) {
  const resolveProposal = await prepareDelegatedSystemAgentApproval(params);
  return await resolveProposal(params.proposal);
}

async function queueDelegatedApproval(
  params: Parameters<typeof resolveTestProposal>[0],
): Promise<string> {
  const resolution = await resolveTestProposal(params);
  if (resolution.kind !== "approval") {
    throw new Error("expected a human approval request");
  }
  return resolution.id;
}

describe("prepareDelegatedSystemAgentApproval", () => {
  const workerTurnClaim = (claimId: string): WorkerSessionTurnClaim => ({
    sessionId: "delegate-worker",
    claimId,
    runId: "delegated-worker-run",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
  });

  it("refuses to apply a delegated change after its run authority closes", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue(null);
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-closed", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-closed");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-closed",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);

    expect(approvalId).toBeTruthy();
    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(false);
    expect(manager.getSnapshot(approvalId!)?.status).toBe("cancelled");
    await vi.waitFor(() =>
      expect(resolveOperatorApproval).toHaveBeenCalledWith(
        null,
        proposal.hash,
        expect.any(Function),
      ),
    );
  });

  it("rechecks authority after queued approval work before the final effect", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-race", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-race");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-race",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
  });

  it.each(["run", "tool", "gateway", "worker", "session"] as const)(
    "fences Full Access when its %s closes during apply preparation",
    async (owner) => {
      const started = createDeferred();
      const release = createDeferred();
      const effect = vi.fn();
      const proposal = { operation: { kind: "gateway-restart" as const }, hash: "f".repeat(64) };
      const session = {
        engine: {
          resolveOperatorApproval: async (
            decision: ExecApprovalDecision | null,
            _hash: string,
            assertCurrent?: () => void,
          ) => {
            if (decision === null) {
              return null;
            }
            started.resolve();
            await release.promise;
            assertCurrent?.();
            effect();
            return { text: "Applied", action: "none" as const, applied: true };
          },
        },
        ownerKey: "agent:main:main",
        lastUsedAt: 1,
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["delegate-full", session]]);
      let workerActive = true;
      const context = {
        systemAgentSessions: sessions,
        validateAgentRuntimeApprovalAuthority: () => workerActive,
      } as unknown as GatewayRequestContext;
      let liveContext = context;
      const operationalRunInstance = createOperationalRunInstanceRef("full-access-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          approvalAuthority: authority,
          fullPermission: true,
          gatewayContextResolver: () => liveContext,
          approvalSignals: [controller.signal],
          ...(owner === "worker" ? { workerTurnClaim: workerTurnClaim("full-turn") } : {}),
        },
        () =>
          resolveTestProposal({
            context,
            sessions,
            session,
            sessionId: "delegate-full",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );
      await started.promise;
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (owner === "tool") {
        controller.abort();
      } else if (owner === "gateway") {
        liveContext = { ...context };
      } else if (owner === "worker") {
        workerActive = false;
      } else {
        sessions.set("delegate-full", { ...session });
      }
      release.resolve();

      await expect(pending).rejects.toThrow("system-agent approval authority is no longer active");
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("publishes the channel completion after the delegated change is applied", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue({
      text: "Applied",
      action: "none" as const,
      applied: true,
    });
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-applied", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-applied");
    claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-applied",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "applied" }),
      ),
    );
  });

  it("fences a delegated worker turn before the persistent effect", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "d".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    let workerTurnActive = true;
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        if (_decision === null) {
          return null;
        }
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-worker", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) && workerTurnActive,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved: vi.fn() },
      validateAgentRuntimeApprovalAuthority: () => workerTurnActive,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
    claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = workerTurnClaim("turn-1");

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: turnClaim,
      },
      async () => {
        approvalId = await queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    workerTurnActive = false;
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reuses the exact worker approval with Full Access=%s",
    async (fullPermission) => {
      const proposal = {
        operation: { kind: "gateway-restart" as const },
        hash: "e".repeat(64),
      };
      const session = {
        engine: {
          getPendingOperatorProposal: () => proposal,
          resolveOperatorApproval: vi.fn().mockResolvedValue(null),
        },
        lastUsedAt: 1,
        ownerKey: "agent:main:main",
      } as unknown as SystemAgentChatSession;
      const sessions = new Map([["delegate-worker", session]]);
      const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const context = {
        systemAgentApprovalManager: manager,
        broadcast: vi.fn(),
        validateAgentRuntimeApprovalAuthority: () => true,
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
      claimAgentRunDelegatedAuthority(operationalRunInstance);

      const firstClaim = workerTurnClaim("turn-2");
      let firstApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: firstClaim,
        },
        async () => {
          firstApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );
      const secondClaim = workerTurnClaim("turn-2");
      let secondApprovalId: string | undefined;
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          workerTurnClaim: secondClaim,
          fullPermission,
        },
        async () => {
          secondApprovalId = await queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegate-worker",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          });
        },
      );

      expect(secondApprovalId).toBe(firstApprovalId);
      expect(manager.listPendingRecords()).toHaveLength(1);
      expect(session.engine.resolveOperatorApproval).not.toHaveBeenCalled();
    },
  );
});

describe("Full Access delegated chat", () => {
  const verifiedConfig: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
    auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
  };
  const systemAgentTempDirs = useAutoCleanupTempDirTracker(afterEach);
  let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

  beforeAll(() => {
    pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  });

  afterAll(() => {
    pluginMetadataSnapshot?.restore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    resetPluginStateStoreForTests();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    pluginMetadataSnapshot?.rebindForCurrentEnv();
  });

  it.each([
    ...(["typed", "model tool", "planner"] as const).flatMap((source) =>
      (["closed", "live", "live-restricted"] as const).map((previousRun) => ({
        source,
        previousRun,
      })),
    ),
    { source: "typed" as const, previousRun: "storage-failure" as const },
  ])(
    "applies Full Access via $source without inheriting a $previousRun proposal",
    async ({ source, previousRun }) => {
      const stateDir = systemAgentTempDirs.make("openclaw-full-access-change-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));
      pluginMetadataSnapshot?.rebindForCurrentEnv();
      const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
      setupInferenceMocks.resolvePersistentApplyInference.mockResolvedValue(
        fixture.binding.execution,
      );
      const runConfigSet = vi.fn(async () => {});
      let proposed = false;
      const engine = new SystemAgentChatEngine({
        operatorApprovalOnly: true,
        surface: "gateway",
        verifiedInference: fixture.binding,
        deps: {
          ...fixture.deps,
          readConfigFileSnapshot: async () =>
            ({
              exists: true,
              valid: true,
              path: "/tmp/openclaw.json",
              hash: "verified-config",
              config: verifiedConfig,
              runtimeConfig: verifiedConfig,
              sourceConfig: verifiedConfig,
              issues: [],
            }) as never,
          runConfigSet,
        },
        runAgentTurn: async (params) => {
          if (source === "typed" || proposed) {
            return { text: "Config verified." };
          }
          if (source === "planner") {
            return null;
          }
          proposed = true;
          const tool = createSystemAgentTool({
            surface: params.surface,
            approvalArmed: params.approvalArmed,
            operatorApprovalOnly: params.operatorApprovalOnly,
            proposalRef: params.session.proposalRef,
          });
          await tool.execute("propose-config", {
            action: "config_set",
            path: "logging.level",
            value: "debug",
          });
          return { text: "Change proposed." };
        },
        planWithAssistant: async () => {
          proposed = true;
          return { reply: "Change proposed.", command: "config set logging.level debug" };
        },
      });
      vi.spyOn(engine, "loadOverview").mockResolvedValue({
        config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
        agents: [],
        defaultAgentId: "main",
        defaultModel: "openai/gpt-5.5",
        tools: {
          codex: { available: false },
          claude: { available: false },
          gemini: { available: false },
          apiKeys: { openai: false, anthropic: false },
        },
        gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
        references: {
          docsUrl: "https://docs.openclaw.ai",
          sourceUrl: "https://github.com/openclaw/openclaw",
        },
      } as never);
      const delegatedSession: SystemAgentChatSession = {
        engine,
        welcome: "welcome text",
        lastUsedAt: 1,
        ownerKey: JSON.stringify(["main", "agent:main:main"]),
      };
      const sessions = new Map<string, SystemAgentChatSession>([
        ["delegate-full", delegatedSession],
      ]);
      const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const operationalRunInstance = createOperationalRunInstanceRef("delegated-full-run");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const broadcast = vi.fn();
      const context = {
        systemAgentSessions: sessions,
        systemAgentApprovalManager: manager,
        broadcast,
        broadcastToConnIds: vi.fn(),
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext;
      const callChat = async (params: Record<string, unknown>) => {
        const respond = vi.fn<(ok: boolean, payload?: unknown, error?: unknown) => void>();
        const handler = expectDefined(systemAgentHandlers["openclaw.chat"], "chat handler");
        await handler({
          params,
          respond,
          context,
          client: {
            connId: "conn-test",
            connect: { device: { id: "device-test" } },
          } as GatewayClient,
        } as never);
        const [ok, payload, error] = expectDefined(respond.mock.calls[0], "chat response");
        return { ok, payload, error };
      };

      const call = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          fullPermission: true,
        },
        () =>
          callChat({
            sessionId: "delegate-full",
            message:
              source === "typed" ? "config set logging.level debug" : "Change the logging level.",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
          }),
      );

      expect(call.error).toBeUndefined();
      expect(call).toMatchObject({
        ok: true,
        payload: { reply: expect.stringContaining("[openclaw] done: config.set") },
      });
      expect(runConfigSet).toHaveBeenCalledOnce();
      expect(call.payload).not.toHaveProperty("needsApproval");
      expect(call.payload).not.toHaveProperty("proposalId");
      expect(manager.listPendingRecords()).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
      expect(engine.getPendingOperatorProposal()).toBeNull();
      expect(readLastSystemAgentAuditEntry()).toMatchObject({
        operation: "config.set",
        summary: "Set config logging.level",
      });
      expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "assistant",
          text: expect.stringContaining("[openclaw] done: config.set"),
        }),
      );

      const restricted = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          fullPermission: false,
        },
        () =>
          callChat({
            sessionId: "delegate-full",
            message: "config set logging.level info",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
          }),
      );
      expect(restricted.payload).toMatchObject({ needsApproval: true });
      expect(runConfigSet).toHaveBeenCalledOnce();
      expect(manager.listPendingRecords()).toHaveLength(1);
      const pending = expectDefined(manager.listPendingRecords()[0], "restricted proposal");
      if (previousRun === "closed") {
        releaseAgentRunDelegatedAuthority(authority);
        manager.forceDenyIfRuntimeAuthorityClosed(pending.id);
        expect(manager.getSnapshot(pending.id)?.status).toBe("cancelled");
      }

      const replacementRun = createOperationalRunInstanceRef("delegated-replacement-run");
      const replacementAuthority = claimAgentRunDelegatedAuthority(replacementRun);
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(previousRun !== "closed");
      expect(validateAgentRunDelegatedAuthority(replacementAuthority)).toBe(true);
      const readOnly = () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            operationalRunInstance: replacementRun,
            fullPermission: previousRun !== "live-restricted",
          },
          () =>
            callChat({
              sessionId: "delegate-full",
              message: "config get logging.level",
              delegation: { agentId: "main", sessionKey: "agent:main:main" },
            }),
        );
      if (previousRun === "storage-failure") {
        const forceDeny = manager.forceDenyIfRuntimeAuthorityClosed.bind(manager);
        const storageFailure = vi
          .spyOn(manager, "forceDenyIfRuntimeAuthorityClosed")
          .mockImplementation((id) => {
            if (!delegatedSession.pendingApproval) {
              manager.forceDenyDetailed(id, "storage-corrupt", { kind: "system", id: null });
              throw new Error("approval storage unavailable");
            }
            return forceDeny(id);
          });
        await expect(readOnly()).rejects.toThrow("approval storage unavailable");
        expect(engine.getPendingOperatorProposal()).toBeNull();
        storageFailure.mockRestore();
      }
      const readOnlyReply = await readOnly();
      expect(readOnlyReply.error).toBeUndefined();
      expect(readOnlyReply.payload).toMatchObject({
        reply: expect.stringContaining("logging.level: not set"),
      });
      expect(runConfigSet).toHaveBeenCalledOnce();
      expect(engine.getPendingOperatorProposal()).toBeNull();
      expect(manager.listPendingRecords()).toEqual([]);
      expect(manager.resolve(pending.id, "allow-once", "late-operator")).toBe(false);
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(previousRun !== "closed");
    },
  );
});
