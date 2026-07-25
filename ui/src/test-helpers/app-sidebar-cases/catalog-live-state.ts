import { describe, expect, it } from "vitest";
import { SessionCatalogLiveState } from "../../components/app-sidebar-session-catalog-live.ts";

describe("AppSidebar session catalog pagination", () => {
  it("keeps the current refetch guard when an older request finishes", () => {
    const live = new SessionCatalogLiveState();
    const older = live.beginRefetch(true);
    const current = live.beginRefetch(true);

    live.endRefetch(older);
    expect(live.refetching).toBe(true);
    live.endRefetch(current);
    expect(live.refetching).toBe(false);
  });

  it("invalidates request ownership when live state is cleared", () => {
    const live = new SessionCatalogLiveState();
    const first = live.beginRequest(1);
    live.clear();
    const second = live.beginRequest(1);

    expect(live.ownsRequest(first.requestOwner)).toBe(false);
    expect(live.ownsRequest(second.requestOwner)).toBe(true);
  });
});
