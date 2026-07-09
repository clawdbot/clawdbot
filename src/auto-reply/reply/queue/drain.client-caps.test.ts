import { describe, expect, it } from "vitest";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "./drain.js";

describe("followup delivery context client capabilities", () => {
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
});
