// Covers delegated system-agent approval ownership and closure.

import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
import {
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
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

describe("Full Access delegated chat", () => {
  const verifiedConfig: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
    auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
  };
  const systemAgentTempDirs = createTempDirTracker();
  const approvalManagers: Array<{
    manager: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
    databasePath: string;
  }> = [];
  let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

  beforeAll(() => {
    pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  });

  afterEach(async () => {
    for (const { manager, databasePath } of approvalManagers.splice(0)) {
      await manager.drain();
      closeOpenClawStateDatabaseByPath(databasePath);
    }
    vi.restoreAllMocks();
    vi.resetAllMocks();
    resetPluginStateStoreForTests();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();

    systemAgentTempDirs.cleanup();
  });

  async function createDelegatedChatFixture(
    source: "typed" | "model tool" = "typed",
    previousRun = "live",
  ) {
    const stateDir = systemAgentTempDirs.make("openclaw-full-access-change-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));

    const fixture = await pluginMetadataSnapshot!.run(() =>
      createSystemAgentVerifiedInferenceTestFixture(verifiedConfig),
    );
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
    const sessions = new Map<string, SystemAgentChatSession>([["delegate-full", delegatedSession]]);
    const approvalDatabasePath = path.join(stateDir, "approvals.sqlite");
    if (previousRun === "registration-failure") {
      fs.mkdirSync(approvalDatabasePath);
    }
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      persistence: {
        runtimeEpoch: "delegated-approval-test",
        databaseOptions: { path: approvalDatabasePath },
      },
    });
    approvalManagers.push({ manager, databasePath: approvalDatabasePath });
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-full-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const requested = createDeferred();
    const broadcast = vi.fn((event: string) => {
      if (event === "openclaw.approval.requested") {
        requested.resolve();
      }
    });
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
      await pluginMetadataSnapshot!.run(() =>
        handler({
          params,
          respond,
          context,
          client: {
            connId: "conn-test",
            connect: { device: { id: "device-test" } },
          } as GatewayClient,
        } as never),
      );
      const [ok, payload, error] = expectDefined(respond.mock.calls[0], "chat response");
      return { ok, payload, error };
    };
    return {
      engine,
      manager,
      authority,
      operationalRunInstance,
      sessions,
      delegatedSession,
      context,
      runConfigSet,
      broadcast,
      callChat,
      requested,
      approvalDatabasePath,
    };
  }

  it.each([
    "allow",
    "deny",
    "expired",
    "run-cancelled",
    "tool-cancelled",
    "apply-failed",
    "queued-cancelled",
    "precommit-cancelled",
    "afterDecision-failed",
    "gateway-close",
  ] as const)(
    "keeps delegated chat pending without blocking other work until %s settles",
    async (outcome) => {
      const {
        engine,
        manager,
        authority,
        operationalRunInstance,
        runConfigSet,
        callChat,
        requested,
        approvalDatabasePath,
      } = await createDelegatedChatFixture("typed", "durable");
      const controller = new AbortController();
      const observation = new AsyncWorkScope();
      if (outcome === "expired") {
        vi.useFakeTimers();
      }
      const applyStarted = createDeferred();
      const releaseApply = createDeferred();
      const execution = await setupInferenceMocks.resolvePersistentApplyInference();
      if (outcome === "precommit-cancelled" || outcome === "afterDecision-failed") {
        setupInferenceMocks.resolvePersistentApplyInference.mockImplementationOnce(async () => {
          applyStarted.resolve();
          await releaseApply.promise;
          if (outcome === "afterDecision-failed") {
            throw new Error("inference unavailable");
          }
          return execution;
        });
      }
      if (outcome === "apply-failed") {
        runConfigSet.mockRejectedValueOnce(new Error("write failed"));
      }
      let sameOwner: Promise<Awaited<ReturnType<typeof callChat>>> | undefined;
      let settled = false;
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          approvalSignals: [controller.signal],
        },
        () =>
          observation.track(() =>
            callChat({
              sessionId: "delegate-full",
              message: "config set logging.level debug",
              delegation: { agentId: "main", sessionKey: "agent:main:main" },
            }),
          ),
      ).then((result) => {
        settled = true;
        return result;
      });
      try {
        await requested.promise;
        const record = expectDefined(manager.listPendingRecords()[0], "pending approval");
        await runSystemAgentGatewayTask(async () => undefined);
        expect.soft(settled).toBe(false);
        expect(runConfigSet).not.toHaveBeenCalled();
        if (outcome === "gateway-close") {
          const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
          observation.beginClose();
          await rejected;
          await observation.drain();
          expect(
            getOperatorApprovalDetailed({
              id: record.id,
              databaseOptions: { path: approvalDatabasePath },
            }),
          ).toMatchObject({ outcome: "found", record: { status: "pending" } });
          expect(engine.getPendingOperatorProposal()).not.toBeNull();
          expect(runConfigSet).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "allow") {
          sameOwner = withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance },
            () =>
              callChat({
                sessionId: "delegate-full",
                message: "Has it finished?",
                delegation: { agentId: "main", sessionKey: "agent:main:main" },
              }),
          );
          await runSystemAgentGatewayTask(async () => undefined);
          expect(manager.listPendingRecords()).toHaveLength(1);
        }
        if (outcome === "expired") {
          await vi.advanceTimersByTimeAsync(SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
        } else if (outcome === "run-cancelled") {
          releaseAgentRunDelegatedAuthority(authority);
          manager.forceDenyIfRuntimeAuthorityClosed(record.id);
        } else if (outcome === "tool-cancelled") {
          controller.abort();
        } else {
          const queued =
            outcome === "queued-cancelled"
              ? runSystemAgentGatewayTask(async () => {
                  applyStarted.resolve();
                  await releaseApply.promise;
                })
              : undefined;
          if (queued) {
            await applyStarted.promise;
          }
          expect(
            manager.resolve(record.id, outcome === "deny" ? "deny" : "allow-once", "operator-ui"),
          ).toBe(true);
          if (queued || outcome === "precommit-cancelled" || outcome === "afterDecision-failed") {
            await applyStarted.promise;
            if (outcome !== "afterDecision-failed") {
              controller.abort();
            }
            releaseApply.resolve();
            await queued;
          }
        }
        const result = await pending;
        if (sameOwner) {
          expect((await sameOwner).payload).toEqual(result.payload);
        }
        if (outcome === "queued-cancelled" || outcome === "precommit-cancelled") {
          expect(
            getOperatorApprovalDetailed({
              id: record.id,
              databaseOptions: { path: approvalDatabasePath },
            }),
          ).toMatchObject({
            outcome: "found",
            record: { decision: "allow-once", status: "allowed" },
          });
          expect(manager.resolve(record.id, "allow-once", "late-operator")).toBe(false);
        }
        const expected =
          outcome === "allow"
            ? "[openclaw] done: config.set"
            : outcome === "deny"
              ? "Denied"
              : outcome === "expired"
                ? "expired"
                : outcome === "apply-failed" || outcome === "afterDecision-failed"
                  ? "failed"
                  : "cancelled";
        expect.soft(result.payload).toMatchObject({ reply: expect.stringContaining(expected) });
        expect.soft(result.payload).not.toHaveProperty("needsApproval");
        expect.soft(result.payload).not.toHaveProperty("proposalId");
        await vi.waitFor(() => expect(engine.getPendingOperatorProposal()).toBeNull());
        expect(runConfigSet).toHaveBeenCalledTimes(
          outcome === "allow" || outcome === "apply-failed" ? 1 : 0,
        );
        if (outcome === "allow" || outcome === "afterDecision-failed") {
          expect(
            transcriptStoreMocks.appendTranscriptTurn.mock.calls.filter(([turn]) =>
              turn.text.includes(
                outcome === "allow" ? "[openclaw] done: config.set" : "failed to complete",
              ),
            ),
          ).toHaveLength(1);
        }
      } finally {
        releaseApply.resolve();
        controller.abort();
        for (const record of manager.listPendingRecords()) {
          manager.expire(record.id);
        }
        await Promise.allSettled([pending]);
        await sameOwner;
        await manager.drain();
        await observation.drain();
        await engine.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ...(["typed", "model tool"] as const).flatMap((source) =>
      (["closed", "live", "live-restricted"] as const).map((previousRun) => ({
        source,
        previousRun,
      })),
    ),
    { source: "typed" as const, previousRun: "storage-failure" as const },
    { source: "typed" as const, previousRun: "unregistered-closed" as const },
    { source: "typed" as const, previousRun: "registration-failure" as const },
  ])(
    "applies Full Access via $source without inheriting a $previousRun proposal",
    async ({ source, previousRun }) => {
      const {
        engine,
        manager,
        authority,
        operationalRunInstance,
        delegatedSession,
        runConfigSet,
        broadcast,
        callChat,
        requested,
      } = await createDelegatedChatFixture(source, previousRun);

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

      if (previousRun === "unregistered-closed") {
        const handle = engine.handle.bind(engine);
        vi.spyOn(engine, "handle").mockImplementationOnce(async (...args) => {
          const reply = await handle(...args);
          // Close the real requesting run after staging, before the Gateway resolves its proposal.
          expect(engine.getPendingOperatorProposal()?.operation).toEqual({
            kind: "config-set",
            path: "logging.level",
            value: "info",
          });
          expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
          return reply;
        });
      }
      const proposalCall = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          fullPermission: previousRun === "unregistered-closed",
        },
        () =>
          callChat({
            sessionId: "delegate-full",
            message: "config set logging.level info",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
          }),
      );
      if (previousRun === "unregistered-closed" || previousRun === "registration-failure") {
        await expect(proposalCall).rejects.toThrow(
          previousRun === "unregistered-closed"
            ? "system-agent approval authority is no longer active"
            : /EISDIR|directory|open database/u,
        );
        expect.soft(delegatedSession.pendingApproval).toBeUndefined();
        expect(manager.listPendingRecords()).toEqual([]);
        expect.soft(engine.getPendingOperatorProposal()).toBeNull();
      } else {
        await requested.promise;
        expect(manager.listPendingRecords()).toHaveLength(1);
      }
      expect(runConfigSet).toHaveBeenCalledOnce();
      const pending = manager.listPendingRecords()[0];
      if (previousRun === "closed") {
        releaseAgentRunDelegatedAuthority(authority);
        const pendingId = expectDefined(pending, "restricted proposal").id;
        manager.forceDenyIfRuntimeAuthorityClosed(pendingId);
        expect(manager.getSnapshot(pendingId)?.status).toBe("cancelled");
      }

      const replacementRun = createOperationalRunInstanceRef("delegated-replacement-run");
      const replacementAuthority = claimAgentRunDelegatedAuthority(replacementRun);
      const previousAuthorityActive =
        previousRun !== "closed" && previousRun !== "unregistered-closed";
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(previousAuthorityActive);
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
      expect.soft(runConfigSet).toHaveBeenCalledOnce();
      expect(readOnlyReply.payload).toMatchObject({
        reply: expect.stringContaining("logging.level: not set"),
      });
      expect(engine.getPendingOperatorProposal()).toBeNull();
      expect(manager.listPendingRecords()).toEqual([]);
      if (pending) {
        expect(manager.resolve(pending.id, "allow-once", "late-operator")).toBe(false);
        expect((await proposalCall).payload).toMatchObject({
          reply: expect.stringContaining("cancelled"),
        });
      }
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(previousAuthorityActive);
    },
  );
});
