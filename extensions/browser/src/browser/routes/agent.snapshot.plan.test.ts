import { describe, expect, it } from "vitest";
import type { ResolvedBrowserProfile } from "../config.js";
import { resolveSnapshotPlan } from "./agent.snapshot.plan.js";

function profile(driver: "existing-session" | "openclaw"): ResolvedBrowserProfile {
  return {
    name: driver === "existing-session" ? "user" : "openclaw",
    driver,
    cdpPort: driver === "existing-session" ? 0 : 18792,
    cdpUrl: driver === "existing-session" ? "" : "http://127.0.0.1:18792",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#00AA00",
    attachOnly: driver === "existing-session",
  };
}

describe("resolveSnapshotPlan", () => {
  it("defaults existing-session snapshots to ai when format is omitted", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("existing-session"),
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });

  it("keeps ai snapshots for managed browsers when Playwright is available", () => {
    const plan = resolveSnapshotPlan({
      profile: profile("openclaw"),
      query: {},
      hasPlaywright: true,
    });

    expect(plan.format).toBe("ai");
  });
});
