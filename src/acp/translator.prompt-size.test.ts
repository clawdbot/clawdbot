import { describe, it, vi } from "vitest";
import { expectOversizedPromptRejected } from "./translator.bridge-test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
