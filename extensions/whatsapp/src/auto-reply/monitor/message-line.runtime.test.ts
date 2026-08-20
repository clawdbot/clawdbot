import { describe, expect, it } from "vitest";
import { resolveMessagePrefix } from "./message-line.runtime.js";

describe("WhatsApp message prefix", () => {
  it("reads the agent identity from the canonical roster", () => {
    expect(
      resolveMessagePrefix(
        {
          agents: {
            entries: { main: { identity: { name: "Mainbot" } } },
          },
        },
        "main",
      ),
    ).toBe("[Mainbot]");
  });
});
