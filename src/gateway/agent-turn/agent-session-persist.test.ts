import { describe, expect, it, vi } from "vitest";
import {
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentSessionPatchBuild } from "../server-methods/agent-session-patch.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

describe("persistAgentSessionPhase", () => {
  it("rejects admission persistence when ownership changes during target projection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:owner-race";
      const sessionId = "owner-race-session";
      const runId = "owner-race-run";
      const scope = { agentId: "main", env: state.env, sessionKey };
      const entry = { sessionId, updatedAt: 1 };
      await upsertSessionEntryCore(scope, entry);
      const patchBuild: AgentSessionPatchBuild = {
        patch: { label: "stale admission", sessionId, updatedAt: 3 },
        spawnedBy: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        freshSessionRotatedSinceLoad: false,
        isNewSession: false,
        rotatedSessionId: false,
        usableRequestedSessionId: sessionId,
        freshness: undefined,
      };
      let assigned = false;

      await expect(
        persistAgentSessionPhase({
          request: { message: "owner race", idempotencyKey: runId },
          cfg: {},
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
          buildSessionPatch: () => {
            if (!assigned) {
              assigned = true;
              assignSessionOwner(scope, {
                owner: { type: "human", id: "profile-owner" },
                assignedBy: { type: "human", id: "profile-assigner" },
                assignedAt: 2,
              });
            }
            return patchBuild;
          },
          initialSessionEntry: entry,
          initialResolvedSessionId: sessionId,
          initialSessionPersistedBeforeGatewayAdmission: true,
          touchInteraction: false,
          bestEffortDeliver: false,
          expectedSession: undefined,
          maintenanceConfig: undefined,
          abortForLifecycleRotation: () => false,
          assertGatewayWorkAdmissionAllowed: vi.fn(),
          respondToGatewayAdmissionOutcome: () => false,
          updateAdmissionState: vi.fn(),
          getAdmittedSessionId: () => sessionId,
          setCronContinuationClaim: vi.fn(),
          setMainRestartRecoveryOwnerLease: vi.fn(),
          respond: vi.fn(),
        }),
      ).rejects.toThrow("SQLite session state changed while preparing session-entry-target.patch");

      expect(loadSessionEntry(scope)).toMatchObject({
        owner: {
          actor: { type: "human", id: "profile-owner" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 2,
        },
        sessionId,
      });
      expect(loadSessionEntry(scope)).not.toHaveProperty("label");
    });
  });

  it("sandboxes a new synthetic run using its host-minted operator identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("synthetic-sandbox-creator@example.com");
      const sessionKey = "agent:main:synthetic-sandbox";
      const runId = "synthetic-sandbox-run";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
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

      const result = await persistAgentSessionPhase({
        request: { message: "sandboxed", idempotencyKey: runId },
        cfg: {
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  sessions: { others: "view" },
                  agents: ["main"],
                  scopes: ["operator.write"],
                  sandbox: "required",
                },
              },
            },
          },
        },
        storePath,
        canonicalSessionKey: sessionKey,
        sessionAgentId: "main",
        mainSessionKey: "agent:main:main",
        creation: { via: "run" },
        operatorRoleActor: { kind: "operator", profileId: profile.id },
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
        abortForLifecycleRotation: () => false,
        assertGatewayWorkAdmissionAllowed: vi.fn(),
        respondToGatewayAdmissionOutcome: () => false,
        updateAdmissionState: vi.fn(),
        getAdmittedSessionId: () => runId,
        setCronContinuationClaim: vi.fn(),
        setMainRestartRecoveryOwnerLease: vi.fn(),
        respond: vi.fn(),
      });

      expect(result?.sessionEntry).toMatchObject({
        createdVia: "run",
        createdActor: { type: "human", id: profile.id },
        sandbox: "required",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        sandbox: "required",
      });
    });
  });

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
