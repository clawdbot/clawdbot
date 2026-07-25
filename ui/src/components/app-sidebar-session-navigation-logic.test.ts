import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { buildSidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";

function projectDraftOwnership(
  row: Pick<GatewaySessionRow, "createdActor" | "sharingRole" | "visibility">,
  selfUserId?: string,
): boolean | undefined {
  const context = {
    basePath: "",
    agentSelection: { state: { selectedId: "main" } },
    gateway: {
      snapshot: {
        assistantAgentId: "main",
        hello: null,
        selfUser: selfUserId ? { id: selfUserId } : undefined,
      },
    },
    sessions: { pullRequestSummary: () => undefined },
  } as unknown as Parameters<typeof buildSidebarSessionNavigationState>[0]["context"];
  const navigation = buildSidebarSessionNavigationState({
    context,
    routeSessionKey: "agent:main:main",
    sessionsResult: null,
    sessionsAgentId: null,
    showCron: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: false,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxCountForSessionKey: () => 0,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });
  return navigation.toSidebarSession({
    key: "agent:main:draft",
    kind: "direct",
    updatedAt: 1,
    ...row,
  }).draftOwnedBySelf;
}

describe("sidebar draft ownership presentation", () => {
  it("keeps owner drafts at normal emphasis", () => {
    expect(
      projectDraftOwnership({
        visibility: "draft",
        sharingRole: "owner",
        createdActor: undefined,
      }),
    ).toBe(true);
  });

  it("distinguishes an admin's own draft from another person's draft", () => {
    const ownDraft = {
      visibility: "draft" as const,
      sharingRole: "admin" as const,
      createdActor: { type: "human" as const, id: "admin" },
    };
    expect(projectDraftOwnership(ownDraft, "admin")).toBe(true);
    expect(projectDraftOwnership(ownDraft, "teammate")).toBe(false);
  });

  it("never marks a shared session as an owned draft", () => {
    expect(
      projectDraftOwnership(
        {
          visibility: "shared",
          sharingRole: "owner",
          createdActor: { type: "human", id: "owner" },
        },
        "owner",
      ),
    ).toBe(false);
  });
});
