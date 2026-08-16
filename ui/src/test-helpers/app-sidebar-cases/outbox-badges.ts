import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../components/app-sidebar.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";

describe("AppSidebar outbox badges", () => {
  it("shows draft pencils only for inactive sessions with stored composer text", async () => {
    const draftKey = "agent:main:draft-thread";
    const activeDraftKey = "agent:main:active-draft-thread";
    const plainKey = "agent:main:plain-thread";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", [draftKey, activeDraftKey, plainKey]),
    );
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = activeDraftKey;
    sidebar.hasSessionDraft = (sessionKey) =>
      sessionKey === draftKey || sessionKey === activeDraftKey;
    await sidebar.updateComplete;

    const draftBadge = sidebar.querySelector<HTMLElement>(
      `[data-session-key="${draftKey}"] .session-row-badge--draft`,
    );
    expect(draftBadge?.getAttribute("aria-label")).toBe("Unsent draft");
    expect(
      sidebar.querySelector(`[data-session-key="${activeDraftKey}"] .session-row-badge--draft`),
    ).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${plainKey}"] .session-row-badge--draft`),
    ).toBeNull();
  });

  it("shows connected session outbox counts and removes the badge when empty", async () => {
    const sessionKey = "agent:main:queued-thread";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", [sessionKey]));
    sidebar.connected = true;
    sidebar.outboxCountForSession = (rowSessionKey) => (rowSessionKey === sessionKey ? 3 : 0);
    await sidebar.updateComplete;

    const badge = sidebar.querySelector<HTMLElement>(
      `[data-session-key="${sessionKey}"] .session-row-badge--queued`,
    );
    expect(badge?.textContent).toContain("3");
    expect(badge?.getAttribute("aria-label")).toBe("3 messages queued to send");

    sidebar.outboxCountForSession = () => 0;
    await sidebar.updateComplete;
    expect(
      sidebar.querySelector(`[data-session-key="${sessionKey}"] .session-row-badge--queued`),
    ).toBeNull();
  });

  it("resolves agent-main aliases to one queued badge count", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
    );
    sidebar.outboxCountForSession = () => 3;
    sidebar.hasSessionDraft = () => true;
    await sidebar.updateComplete;

    const badges = sidebar.querySelectorAll(".nav-item--home .session-row-badge--queued");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("3");
    expect(
      sidebar.querySelector('.nav-item--home .session-row-badge--draft[aria-label="Unsent draft"]'),
    ).not.toBeNull();
  });
});
