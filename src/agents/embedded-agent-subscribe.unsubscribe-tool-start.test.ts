import { describe, expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";

describe("subscribeEmbeddedAgentSession unsubscribe tool cleanup", () => {
  it("removes only the unsubscribed run's unfinished tool starts", () => {
    const first = createSubscribedSessionHarness({ runId: "cleanup-first" });
    const second = createSubscribedSessionHarness({ runId: "cleanup-second" });

    first.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "first-tool",
      args: { path: "/tmp/first" },
    });
    second.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "second-tool",
      args: { path: "/tmp/second" },
    });

    expect(countActiveToolExecutions("cleanup-first")).toBe(1);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    first.subscription.unsubscribe();

    expect(countActiveToolExecutions("cleanup-first")).toBe(0);
    expect(countActiveToolExecutions("cleanup-second")).toBe(1);

    second.subscription.unsubscribe();
    expect(countActiveToolExecutions("cleanup-second")).toBe(0);
  });
});
