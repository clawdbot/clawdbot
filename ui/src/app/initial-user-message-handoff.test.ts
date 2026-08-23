import { describe, expect, it } from "vitest";
import {
  createInitialUserMessageHandoff,
  type ApplicationInitialUserMessage,
} from "./initial-user-message-handoff.ts";

function message(text: string): ApplicationInitialUserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("initial user message handoff", () => {
  it("stores run ownership and preserves client privacy until clearing", () => {
    const handoff = createInitialUserMessageHandoff();
    const owner = {};
    const replacementOwner = {};
    const first = message("first");
    handoff.prepare({
      sessionKey: "agent:main:main",
      message: first,
      owner,
      pendingRunId: "initial-run",
    });

    expect(handoff.read("main", owner)).toEqual({
      sessionKey: "agent:main:main",
      message: first,
      owner,
      pendingRunId: "initial-run",
    });
    expect(handoff.read("main", replacementOwner)).toBeNull();
    handoff.clear("agent:main:missing");
    expect(handoff.read("main", owner)).not.toBeNull();
    handoff.clear("agent:main:main");
    expect(handoff.read("main", owner)).toBeNull();
  });
});
