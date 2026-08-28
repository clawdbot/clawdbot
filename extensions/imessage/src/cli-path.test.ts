// Imessage plugin tests cover CLI path tilde expansion.
import { describe, expect, it } from "vitest";
import { expandIMessageUserPath } from "./cli-path.js";

describe("expandIMessageUserPath", () => {
  it("does not interpret $ patterns in home when expanding tildes", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/home/user$&d";
    try {
      expect(expandIMessageUserPath("~/Library/Messages/chat.db")).toBe(
        "/home/user$&d/Library/Messages/chat.db",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous;
      }
    }
  });
});
