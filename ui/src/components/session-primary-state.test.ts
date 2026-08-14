import { describe, expect, it } from "vitest";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { resolveSessionPrimaryState } from "./session-primary-state.ts";

function sessionWith(attention: SidebarSessionAttention): SidebarRecentSession {
  return {
    attention,
    hasActiveRun: false,
    visuallyActive: false,
    unread: false,
  } as unknown as SidebarRecentSession;
}

describe("resolveSessionPrimaryState", () => {
  // A child row carries no subtitle, so the state slot is the only place an
  // actionable session can announce itself. Anything that resolves to attention
  // is something the operator has to act on, and this slot reads "Session needs
  // attention" rather than "failed", so every kind shares it.
  const actionable: SidebarSessionAttention[] = [
    { kind: "error", reason: "Provider credits exhausted" },
    { kind: "question" },
    { kind: "approval" },
    { kind: "agent", note: "Waiting on the release branch", icon: "info" },
  ] as unknown as SidebarSessionAttention[];

  it.each(actionable)("reports $kind attention as blocked", (attention) => {
    expect(resolveSessionPrimaryState(sessionWith(attention))).toEqual({ kind: "blocked" });
  });

  it("leaves a session with no attention to its unread state", () => {
    expect(resolveSessionPrimaryState(sessionWith({ kind: "none" }))).toEqual({ kind: "none" });
    expect(
      resolveSessionPrimaryState({
        ...sessionWith({ kind: "none" }),
        unread: true,
      } as SidebarRecentSession),
    ).toEqual({ kind: "unread" });
  });

  it("lets a live run and an open row outrank pending attention", () => {
    expect(
      resolveSessionPrimaryState({
        ...sessionWith({ kind: "approval" }),
        hasActiveRun: true,
      } as SidebarRecentSession),
    ).toEqual({ kind: "running" });
    expect(
      resolveSessionPrimaryState({
        ...sessionWith({ kind: "approval" }),
        visuallyActive: true,
      } as SidebarRecentSession),
    ).toEqual({ kind: "none" });
  });
});
