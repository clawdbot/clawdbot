import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  ArtifactSessionResolutionError,
  resolveAuthorizedArtifactSession,
} from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  getTaskSession: vi.fn(),
  resolveRunSession: vi.fn(),
}));

vi.mock("../../tasks/task-status-access.js", () => ({
  getTaskSessionLookupByIdForStatus: mocks.getTaskSession,
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: mocks.resolveRunSession,
}));

function identifiedClient(scopes: string[]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    authenticatedUserId: "viewer@example.com",
    authenticatedUserProfile: {
      profileId: "viewer@example.com",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("artifact session authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies direct and indirect incognito selectors while preserving admin access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:incognito-artifacts";
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-incognito-artifacts",
          updatedAt: 1,
          incognito: true,
          visibility: "shared",
        },
      );
      mocks.getTaskSession.mockReturnValue({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        ownerKey: sessionKey,
      });
      mocks.resolveRunSession.mockReturnValue(sessionKey);
      const viewer = identifiedClient(["operator.read"]);

      expect(() =>
        resolveAuthorizedArtifactSession(
          { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
          cfg,
          viewer,
        ),
      ).toThrow('Incognito session "dashboard:incognito-artifacts" was not found.');
      for (const query of [{ taskId: "task-private" }, { runId: "run-private" }]) {
        try {
          resolveAuthorizedArtifactSession(query, cfg, viewer);
          throw new Error("expected incognito artifact selector to be denied");
        } catch (error) {
          expect(error).toBeInstanceOf(ArtifactSessionResolutionError);
          expect((error as ArtifactSessionResolutionError).shape).toMatchObject({
            message: "no session found for artifact query",
            details: { type: "artifact_scope_not_found" },
          });
        }
      }

      expect(
        resolveAuthorizedArtifactSession(
          { sessionKey: "dashboard:incognito-artifacts", agentId: "main" },
          cfg,
          identifiedClient(["operator.admin"]),
        ),
      ).toMatchObject({ sessionKey });
    });
  });
});
