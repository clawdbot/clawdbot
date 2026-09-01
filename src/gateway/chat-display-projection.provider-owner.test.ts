import { expect, it, vi } from "vitest";
import { classifyProviderFailoverSignalWithPlugin } from "../plugins/provider-failover.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";

vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => "context_overflow"),
}));

it("projects recorded errors without discovering unrelated provider policy", () => {
  expect(
    projectChatDisplayMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "prompt reached the tenant maximum",
      content: [],
    }),
  ).toMatchObject({
    content: [{ type: "text", text: "The agent run failed before producing a reply." }],
  });
  expect(classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});
