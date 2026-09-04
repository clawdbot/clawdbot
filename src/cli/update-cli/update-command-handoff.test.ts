import { describe, expect, it } from "vitest";
import {
  formatUpdateAncestryBlockMessage,
  gatewayAncestryBlockMessage,
} from "./update-command-handoff.js";

describe("gatewayAncestryBlockMessage", () => {
  it("never advises stopping the gateway service or running update from the caller", () => {
    const message = gatewayAncestryBlockMessage(process.pid);
    expect(message).toContain("inside the gateway process tree");
    expect(message).toContain("from a shell outside the gateway service");
    expect(message).not.toContain("stop the gateway service first");
    expect(message).not.toContain("openclaw update");
  });

  it("returns undefined when the pid is not an ancestor", () => {
    expect(gatewayAncestryBlockMessage(2)).toBeUndefined();
  });
});

describe("formatUpdateAncestryBlockMessage", () => {
  it("adds the chat handoff advice only to ancestry blocks", () => {
    const ancestry = gatewayAncestryBlockMessage(process.pid) ?? "";
    expect(formatUpdateAncestryBlockMessage(ancestry)).toContain("/update");
    expect(formatUpdateAncestryBlockMessage("service inspection unavailable")).toBe(
      "service inspection unavailable",
    );
  });
});
