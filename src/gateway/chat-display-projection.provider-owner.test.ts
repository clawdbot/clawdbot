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

it("projects the persisted storage failure with actionable copy", () => {
  expect(
    projectChatDisplayMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "database is locked",
      content: [],
    }),
  ).toMatchObject({
    content: [
      {
        type: "text",
        text: "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
      },
    ],
  });
});
