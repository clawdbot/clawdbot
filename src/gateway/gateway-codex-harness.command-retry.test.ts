import { describe, expect, it } from "vitest";
import { requireSuccessfulNativeCommandExecution } from "./gateway-codex-harness.live-helpers.js";

describe("Codex gateway command retry evidence", () => {
  it("accepts a successful retry after an earlier matching command fails", () => {
    const expectedCommand = "node -e OPENCLAW-RETRY";
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          itemId: "item-first",
          args: { command: expectedCommand },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          itemId: "item-first",
          status: "completed",
          isError: true,
          result: { exitCode: 1 },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "bash",
          itemId: "item-retry",
          args: { command: expectedCommand },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          itemId: "item-retry",
          status: "completed",
          isError: false,
          result: { exitCode: 0 },
        },
      },
    ];

    expect(
      requireSuccessfulNativeCommandExecution(events, {
        commandMarker: "OPENCLAW-RETRY",
        expectedCommand,
      }),
    ).toEqual({ itemId: "item-retry", resultIndex: 3, startIndex: 2 });
  });
});
