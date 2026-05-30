import { describe, expect, it } from "vitest";
import { createCustomMessage } from "./messages.js";

describe("harness message timestamps", () => {
  it("rejects invalid timestamps before creating context messages", () => {
    expect(() => createCustomMessage("note", "content", true, {}, "not-a-date")).toThrow(
      "custom message timestamp must be a valid timestamp",
    );
  });
});
