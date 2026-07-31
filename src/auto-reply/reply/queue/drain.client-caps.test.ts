import { describe, expect, it } from "vitest";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "./drain.js";

describe("followup delivery context", () => {
  it("separates runs with different gateway client capabilities", () => {
    const withoutCaps = createQueueTestRun({ prompt: "without caps" });
    const withInlineWidgets = createQueueTestRun({ prompt: "with inline widgets" });
    withInlineWidgets.run.clientCaps = ["inline-widgets"];

    expect(resolveFollowupDeliveryContextKey(withoutCaps)).not.toBe(
      resolveFollowupDeliveryContextKey(withInlineWidgets),
    );
  });

  it("normalizes capability order and duplicates", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.clientCaps = ["tool-events", "inline-widgets"];
    const second = createQueueTestRun({ prompt: "second" });
    second.run.clientCaps = ["inline-widgets", "tool-events", "inline-widgets"];

    expect(resolveFollowupDeliveryContextKey(first)).toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("never collect-batches runs bound to different tool targets", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.toolBindings = { browser: { kind: "tab", targetId: "tab-a" } };
    const second = createQueueTestRun({ prompt: "second" });
    second.run.toolBindings = { browser: { kind: "tab", targetId: "tab-b" } };

    expect(resolveFollowupDeliveryContextKey(first)).not.toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("canonicalizes equivalent tool bindings", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.toolBindings = { browser: { targetId: "tab-a", kind: "tab" } };
    const second = createQueueTestRun({ prompt: "second" });
    second.run.toolBindings = { browser: { kind: "tab", targetId: "tab-a" } };

    expect(resolveFollowupDeliveryContextKey(first)).toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });

  it("separates runs with different parent policy provenance", () => {
    const first = createQueueTestRun({ prompt: "first" });
    first.run.spawnedBy = "agent:main:telegram:group:first";
    const second = createQueueTestRun({ prompt: "second" });
    second.run.spawnedBy = "agent:main:telegram:group:second";

    expect(resolveFollowupDeliveryContextKey(first)).not.toBe(
      resolveFollowupDeliveryContextKey(second),
    );
  });
});
