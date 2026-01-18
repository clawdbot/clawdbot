import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { prependSystemEvents } from "./session-updates.js";

describe("prependSystemEvents", () => {
  it("adds a UTC timestamp to queued system events", async () => {
    vi.useFakeTimers();
    const timestamp = new Date("2026-01-12T20:19:17Z");
    vi.setSystemTime(timestamp);

    enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

    const result = await prependSystemEvents({
      cfg: {} as ClawdbotConfig,
      sessionKey: "agent:main:main",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "User: hi",
    });

    const expectedTimestamp = "2026-01-12T20:19:17Z";

    expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);

    resetSystemEventsForTest();
    vi.useRealTimers();
  });
});
