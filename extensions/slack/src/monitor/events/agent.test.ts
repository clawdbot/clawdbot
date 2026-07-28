// Slack tests cover Agent View lifecycle handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackAgentEvents } from "./agent.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

describe("registerSlackAgentEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records Agent View for app_context_changed", async () => {
    const trackEvent = vi.fn();
    const harness = createSlackSystemEventTestHarness();
    const recordSlackAgentView = vi.fn(async () => undefined);
    harness.ctx.recordSlackAgentView = recordSlackAgentView;
    registerSlackAgentEvents({ ctx: harness.ctx, trackEvent });

    await harness.getHandler("app_context_changed")?.({
      event: {
        type: "app_context_changed",
        user: "U123",
        context: { entities: [] },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(recordSlackAgentView).toHaveBeenCalledTimes(1);
  });

  it("drops mismatched workspace events before recording Agent View", async () => {
    const trackEvent = vi.fn();
    const harness = createSlackSystemEventTestHarness();
    const recordSlackAgentView = vi.fn(async () => undefined);
    harness.ctx.recordSlackAgentView = recordSlackAgentView;
    harness.ctx.shouldDropMismatchedSlackEvent = () => true;
    registerSlackAgentEvents({ ctx: harness.ctx, trackEvent });

    await harness.getHandler("app_context_changed")?.({
      event: { type: "app_context_changed", user: "U123" },
      body: {},
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(recordSlackAgentView).not.toHaveBeenCalled();
  });
});
