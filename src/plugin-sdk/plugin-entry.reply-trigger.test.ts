import { describe, expectTypeOf, it } from "vitest";
import type { OpenClawPluginApi } from "./plugin-entry.js";
import type { PluginHookAgentTrigger } from "./types.js";

function registerScopedReplyHook(api: OpenClawPluginApi): void {
  api.on("before_agent_reply", async () => undefined, { eligibleTriggers: ["heartbeat", "cron"] });

  // @ts-expect-error Trigger eligibility is only supported for before_agent_reply.
  api.on("before_tool_call", async () => undefined, { eligibleTriggers: ["heartbeat"] });
  // @ts-expect-error An empty trigger list cannot prove that a hook is inactive.
  api.on("before_agent_reply", async () => undefined, { eligibleTriggers: [] });
}

void registerScopedReplyHook;

describe("plugin-entry reply trigger contract", () => {
  it("exposes the scoped option through the public plugin API", () => {
    expectTypeOf<OpenClawPluginApi["on"]>().toBeFunction();
    expectTypeOf<PluginHookAgentTrigger>().toEqualTypeOf<"cron" | "heartbeat" | "user">();
  });
});
