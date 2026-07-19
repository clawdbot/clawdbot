import { describe, expect, it } from "vitest";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionSubtitle } from "./session-row-subtitle.ts";

function workSession(): SidebarRecentSession {
  return {
    attention: { kind: "none" },
    hasActiveRun: false,
    label: "Backing session",
    status: "done",
    subtitle: "~/Projects/openclaw",
    workSession: true,
  } as unknown as SidebarRecentSession;
}

describe("resolveSidebarSessionSubtitle", () => {
  it("does not fall back to a backing work subtitle when catalog display omits one", () => {
    expect(
      resolveSidebarSessionSubtitle({
        session: workSession(),
        hasDisplay: true,
        displaySubtitle: undefined,
        sidebarLiveActivity: true,
        narrationLine: undefined,
      }),
    ).toEqual({ subtitle: undefined, narration: undefined });
  });
});
