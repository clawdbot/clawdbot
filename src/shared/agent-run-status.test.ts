import { describe, expect, it } from "vitest";
import { isNonTerminalAgentRunStatus } from "./agent-run-status.js";

describe("isNonTerminalAgentRunStatus", () => {
  it.each(["accepted", "started", "in_flight"])("recognizes %s as non-terminal", (status) => {
    expect(isNonTerminalAgentRunStatus(status)).toBe(true);
  });

  it.each(["ok", "error", "timeout", "queued", "", null, undefined, 1, {}, []])(
    "does not recognize %s as non-terminal",
    (status) => {
      expect(isNonTerminalAgentRunStatus(status)).toBe(false);
    },
  );
});
