import { describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentSessionPatchBuild } from "../server-methods/agent-session-patch.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

describe("persistAgentSessionPhase", () => {
  it("surfaces session creation authorization failures before concurrent lifecycle rotation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:role-denied";
      const runId = "role-denied-run";
      const respond = vi.fn<Parameters<typeof persistAgentSessionPhase>[0]["respond"]>();
      const abortForLifecycleRotation = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const patchBuild: AgentSessionPatchBuild = {
        patch: { sessionId: runId, updatedAt: 1 },
        spawnedBy: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        freshSessionRotatedSinceLoad: false,
        isNewSession: true,
        rotatedSessionId: false,
        usableRequestedSessionId: undefined,
        freshness: undefined,
      };

      await expect(
        persistAgentSessionPhase({
          request: { message: "denied", idempotencyKey: runId },
          cfg: {
            gateway: {
              roles: {
                default: "restricted",
                definitions: {
                  restricted: { sessions: { others: "none" }, agents: [], scopes: [] },
                },
              },
            },
          },
          storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          canonicalSessionKey: sessionKey,
          sessionAgentId: "main",
          mainSessionKey: "agent:main:main",
          creation: { via: "run" },
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          isRestartRecoveryResumeRun: false,
          runId,
          agentId: "main",
          suppressVisibleSessionEffects: false,
          initialPatchBuild: patchBuild,
          buildSessionPatch: () => patchBuild,
          initialSessionPersistedBeforeGatewayAdmission: false,
          touchInteraction: false,
          bestEffortDeliver: false,
          expectedSession: undefined,
          maintenanceConfig: undefined,
          abortForLifecycleRotation,
          assertGatewayWorkAdmissionAllowed: vi.fn(),
          respondToGatewayAdmissionOutcome: () => false,
          updateAdmissionState: vi.fn(),
          getAdmittedSessionId: () => runId,
          setCronContinuationClaim: vi.fn(),
          setMainRestartRecoveryOwnerLease: vi.fn(),
          respond,
        }),
      ).resolves.toBeUndefined();

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: expect.stringContaining('agent "main"'),
        }),
      );
      expect(abortForLifecycleRotation).toHaveBeenCalledTimes(1);
    });
  });
});
