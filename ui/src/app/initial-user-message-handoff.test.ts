import { describe, expect, it, vi } from "vitest";
import {
  createInitialUserMessageHandoff,
  type ApplicationInitialUserMessage,
} from "./initial-user-message-handoff.ts";

function message(text: string): ApplicationInitialUserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("initial user message handoff", () => {
  it("notifies once for actual prepare and clear changes", () => {
    const handoff = createInitialUserMessageHandoff();
    const listener = vi.fn();
    const owner = {};
    const first = message("first");
    const unsubscribe = handoff.subscribe(listener);

    handoff.prepare({ sessionKey: "agent:main:main", message: first, owner });
    expect(listener).toHaveBeenCalledTimes(1);
    handoff.prepare({ sessionKey: "main", message: first, owner });
    expect(listener).toHaveBeenCalledTimes(1);

    handoff.prepare({ sessionKey: "main", message: message("replacement"), owner });
    expect(listener).toHaveBeenCalledTimes(2);
    handoff.clear("agent:main:missing");
    expect(listener).toHaveBeenCalledTimes(2);
    handoff.clear("agent:main:main");
    expect(listener).toHaveBeenCalledTimes(3);
    handoff.clear();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    handoff.prepare({ sessionKey: "main", message: first, owner });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
