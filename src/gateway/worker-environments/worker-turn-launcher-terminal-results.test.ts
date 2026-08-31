import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRunTerminalReplySnapshot,
  type AgentRunTerminalReplySnapshot,
} from "../../agents/agent-run-terminal-reply.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import { NodeWorkerWorkspaceTransferError } from "../../worker/node-workspace-transfer-protocol.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  openSessionManager,
  placements,
  seedActivePlacement,
  sessionFile,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn launcher terminal results", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("requests immediate recovery when reconciliation fails after worker finishing", async () => {
    seedActivePlacement();
    const destroy = vi.fn(async () => attachedEnvironment());
    const tunnelFailure = new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: gateway TLS fingerprint mismatch",
    );
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(),
      measureLaunchTurn,
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Remote work completed" }],
            timestamp: 21,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          claim: request.turnClaim,
          transcriptSeq: 2,
          liveSeq: 1,
        });
        return {
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leafId,
            transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }),
      syncWorkspace: vi.fn(async () => {
        throw new Error("unexpected workspace sync");
      }),
      reconcileWorkspace: vi.fn(async () => {
        throw tunnelFailure;
      }),
      stop: vi.fn(async () => {}),
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => tunnel),
      destroy,
    };
    const reconcileActivePlacement = vi.fn(async () => {
      const [pending] = placements.listPendingWorkspaceResults();
      if (!pending) {
        throw new Error("expected pending workspace result");
      }
      placements.failWorkspaceResultAndReleaseTurn(pending, tunnelFailure);
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reconcile-tunnel-loss",
        },
        turn("run-reconcile-tunnel-loss"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toMatchObject({
      name: "WorkerWorkspaceReconciliationError",
      message:
        "Cloud worker finished, but its workspace result could not be reconciled: workspace-transfer-failed: gateway TLS fingerprint mismatch",
    });

    expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    content: Parameters<typeof makeAgentAssistantMessage>[0]["content"];
    visibleText?: string;
    rawText?: string;
    terminalReply: AgentRunTerminalReplySnapshot;
    costs?: { first: number; last: number; total: number };
  }>([
    {
      name: "visible final answer",
      costs: { first: 0.125, last: 0.25, total: 0.375 },
      content: [
        { type: "thinking", thinking: "Private reasoning" },
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Usage reply",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
      visibleText: "Usage reply",
      rawText: "Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "sanitized final answer",
      content: [{ type: "text", text: "<think>Private reasoning</think>Usage reply" }],
      visibleText: "Usage reply",
      rawText: "<think>Private reasoning</think>Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "explicit silence",
      content: [{ type: "text", text: "NO_REPLY" }],
      visibleText: "NO_REPLY",
      rawText: "NO_REPLY",
      terminalReply: { disposition: "silent" },
    },
    {
      name: "reasoning-only completion",
      content: [{ type: "thinking", thinking: "Private reasoning" }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "tool-only completion",
      content: [{ type: "toolCall", id: "call-final", name: "read", arguments: {} }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "empty final answer",
      content: [],
      terminalReply: { disposition: "empty" },
    },
  ])(
    "reports canonical usage and $name",
    async ({
      content,
      visibleText,
      rawText,
      terminalReply,
      costs = { first: 0, last: 0, total: 0 },
    }) => {
      seedActivePlacement();
      const environments: WorkerTurnEnvironmentService = {
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        acknowledgeCredentialDelivery: vi.fn(() => true),
        startTunnel: vi.fn(async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          quiesceWorkspace: vi.fn(async () => ({
            assertActive: vi.fn(async () => {}),
            resume: vi.fn(async () => {}),
          })),
          runWorkspaceCommand: vi.fn(),
          measureLaunchTurn,
          launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
            request.onDispatchReady?.();
            const completed = openSessionManager();
            completed.appendMessage(
              makeAgentAssistantMessage({
                content: [{ type: "toolCall", id: "call-usage", name: "read", arguments: {} }],
                provider: "openai",
                model: "gpt-first-call",
                stopReason: "toolUse",
                timestamp: 21,
                usage: {
                  input: 100,
                  output: 10,
                  cacheRead: 20,
                  cacheWrite: 5,
                  totalTokens: 135,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.first },
                },
              }),
            );
            completed.appendMessage({
              role: "toolResult",
              toolCallId: "call-usage",
              toolName: "read",
              content: [{ type: "text", text: "usage result" }],
              isError: false,
              timestamp: 22,
            });
            const leafId = completed.appendMessage(
              makeAgentAssistantMessage({
                content,
                provider: "anthropic",
                model: "claude-reported",
                timestamp: 23,
                usage: {
                  input: 200,
                  output: 30,
                  cacheRead: 40,
                  cacheWrite: 0,
                  contextUsage: {
                    state: "available",
                    promptTokens: 240,
                    totalTokens: 270,
                  },
                  totalTokens: 270,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.last },
                },
              }),
            );
            createWorkerSessionPlacementGate(placements).updateAckCursors({
              claim: request.turnClaim,
              transcriptSeq: 2,
              liveSeq: 1,
            });
            return {
              stdout: JSON.stringify({
                status: "completed",
                transcriptLeafId: leafId,
                transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
              }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }),
          syncWorkspace: vi.fn(async () => {
            throw new Error("unexpected workspace sync");
          }),
          reconcileWorkspace: vi.fn(async (request) => {
            request.journal.commit(MANIFEST_REF);
            return {
              manifestRef: MANIFEST_REF,
              changed: false,
              verifyStable: async () => {},
              verifyLocalStable: async () => {},
            };
          }),
          stop: vi.fn(async () => {}),
        })),
        stopTunnel: vi.fn(async () => {}),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

      const result = await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-worker-usage",
        },
        turn("run-worker-usage"),
        async () => ({ meta: { durationMs: 1 } }),
      );

      expect(result.meta.finalAssistantVisibleText).toBe(visibleText);
      expect(result.meta.finalAssistantRawText).toBe(rawText);
      expect(
        buildAgentRunTerminalReplySnapshot({
          visibleText: result.meta.finalAssistantVisibleText,
          rawText: result.meta.finalAssistantRawText,
        }),
      ).toEqual(terminalReply);
      expect(result.meta.agentMeta).toEqual({
        sessionId: SESSION_ID,
        sessionFile,
        provider: "anthropic",
        model: "claude-reported",
        costUsd: costs.total,
        usage: {
          input: 300,
          output: 40,
          cacheRead: 60,
          cacheWrite: 5,
          total: 405,
          cost: { total: costs.total },
        },
        lastCallUsage: {
          input: 200,
          output: 30,
          cacheRead: 40,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 240,
            totalTokens: 270,
          },
          total: 270,
          cost: { total: costs.last },
        },
        promptTokens: 240,
      });
    },
  );
});
