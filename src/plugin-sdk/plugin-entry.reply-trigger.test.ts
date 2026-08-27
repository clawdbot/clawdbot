import { describe, expectTypeOf, it } from "vitest";
import type { OpenClawPluginApi, WorkerMachineOption } from "./plugin-entry.js";
import type { PluginHookAgentTrigger } from "./types.js";

function registerScopedReplyHook(api: OpenClawPluginApi): void {
  api.on("before_agent_reply", async () => undefined, { eligibleTriggers: ["heartbeat", "cron"] });

  // @ts-expect-error Trigger eligibility is only supported for before_agent_reply.
  api.on("before_tool_call", async () => undefined, { eligibleTriggers: ["heartbeat"] });
  // @ts-expect-error An empty trigger list cannot prove that a hook is inactive.
  api.on("before_agent_reply", async () => undefined, { eligibleTriggers: [] });
}

function registerAuthorizedPromptHook(api: OpenClawPluginApi): void {
  api.on(
    "before_prompt_build",
    async (_event, ctx) => {
      const authority = ctx.toolAuthority;
      if (!authority?.allows("memory_search")) {
        return undefined;
      }
      authority.assertActive();
      return { prependContext: `authority:${authority.fingerprint}` };
    },
    { requiresToolAuthority: true },
  );

  // @ts-expect-error Tool authority is only supported for before_prompt_build.
  api.on("before_tool_call", async () => undefined, { requiresToolAuthority: true });
}

void registerScopedReplyHook;
void registerAuthorizedPromptHook;

describe("plugin entry hook option contracts", () => {
  it("exposes scoped reply and prompt authority options through the public plugin API", () => {
    expectTypeOf<OpenClawPluginApi["on"]>().toBeFunction();
    expectTypeOf<PluginHookAgentTrigger>().toEqualTypeOf<"cron" | "heartbeat" | "user">();
    expectTypeOf<WorkerMachineOption>().toEqualTypeOf<{
      readonly id: string;
      readonly label: string;
      readonly cpu?: number;
      readonly memoryGb?: number;
      readonly default?: boolean;
    }>();
  });
});
