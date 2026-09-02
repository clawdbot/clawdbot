// Zalo tests cover lifecycle teardown release of per-agent state databases.
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { resetLifecycleTestState } from "./monitor-mocks-test-support.js";

describe("resetLifecycleTestState", () => {
  afterEach(async () => {
    await resetLifecycleTestState();
  });

  it("closes per-agent state databases so teardown can remove the state dir", async () => {
    // A processed inbound update opens the per-agent DB through the real session
    // accessor inside the envelope builder; teardown must release that handle or
    // Windows cannot remove the temp state dir (EBUSY, issue #119796).
    const handle = openOpenClawAgentDatabase({ agentId: "main" });
    expect(handle.db.isOpen).toBe(true);

    await resetLifecycleTestState();

    expect(handle.db.isOpen).toBe(false);
  });
});
