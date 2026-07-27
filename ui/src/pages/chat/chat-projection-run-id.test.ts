// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveChatProjectionRunId } from "./tool-stream.ts";

describe("resolveChatProjectionRunId", () => {
  it("restores only an active run proven by the reconnecting outbox", () => {
    const reconnecting = {
      id: "reconnecting",
      text: "Current prompt",
      createdAt: 1,
      sendRunId: "run-restored",
      sendState: "waiting-reconnect" as const,
    };

    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-restored");
    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-stale"],
        queue: [reconnecting],
      }),
    ).toBeNull();
    expect(
      resolveChatProjectionRunId({
        localRunId: "run-local",
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-local");
  });
});
