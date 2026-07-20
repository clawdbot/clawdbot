import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar pull request state", () => {
  it("shows the green PR indicator for the matching session", async () => {
    const key = "agent:main:pr-detection";
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", [key, "agent:main:other"]);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    const row = sidebar.querySelector(`[data-session-key="${key}"]`);

    expect(row?.querySelector(".session-row-badge--pull-request")).toBeNull();

    sessions.sessions.setOpenPullRequest(key, true);
    await sidebar.updateComplete;

    const badge = row?.querySelector(".session-row-badge--pull-request");
    expect(badge?.getAttribute("aria-label")).toBe("Open PR");
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:other"] .session-row-badge--pull-request',
      ),
    ).toBeNull();
  });
});
