import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBoardViewTicket } from "../board-view-ticket.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("session sharing board ticket authority", () => {
  it("authorizes tickets against their signed agent and issuing Gateway", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "session-main-global", updatedAt: 1, visibility: "shared" },
      );
      await upsertSessionEntryCore(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "session-work-global",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      let gatewayAActive = true;
      const gatewayARef: { value?: GatewayRequestContext } = {};
      const gatewayA: GatewayRequestContext = {
        ...sessionSharingTestContext(vi.fn(), cfg),
        resolveGatewayContext: () => (gatewayAActive ? gatewayARef.value : undefined),
      };
      gatewayARef.value = gatewayA;
      const gatewayBRef: { value?: GatewayRequestContext } = {};
      const gatewayB: GatewayRequestContext = {
        ...sessionSharingTestContext(vi.fn(), cfg),
        resolveGatewayContext: () => gatewayBRef.value,
      };
      gatewayBRef.value = gatewayB;
      const issueTicket = (agentId?: string) =>
        createBoardViewTicket({
          sessionKey: "global",
          ...(agentId ? { agentId } : {}),
          name: "status",
          revision: 1,
          viewGeneration: agentId ? "a".repeat(32) : "b".repeat(32),
          authority: {
            gatewayContext: gatewayA,
            resolveGatewayContext: gatewayA.resolveGatewayContext!,
          },
        }).ticket;
      const ticket = issueTicket("work");
      const unscopedTicket = issueTicket();
      const memberClient = identifiedClient("outsider@example.com");

      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.action",
          requestParams: { ticket, agentId: "work" },
          context: gatewayB,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
      gatewayAActive = false;
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("owner@example.com"),
          method: "board.event",
          requestParams: { ticket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
      expect(
        resolveSessionMutationAuthorization({
          client: memberClient,
          method: "board.action",
          requestParams: { ticket: unscopedTicket, agentId: "work" },
          context: gatewayA,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    });
  });
});
