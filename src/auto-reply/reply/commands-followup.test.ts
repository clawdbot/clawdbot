// Tests /followup message rewriting and its one-turn queue override.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleFollowupCommand } from "./commands-followup.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

describe("handleFollowupCommand", () => {
  it("queues only the supplied message without changing the stored session mode", async () => {
    const params = buildParams("/followup explain the decision afterward");
    params.sessionEntry = {
      sessionId: "session-active",
      updatedAt: Date.now(),
      queueMode: "steer",
    };

    const result = await handleFollowupCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("explain the decision afterward");
    expect(params.command.commandBodyNormalized).toBe("explain the decision afterward");
    expect(params.directives).toMatchObject({
      hasQueueDirective: true,
      queueMode: "followup",
      queueReset: false,
    });
    expect(params.sessionEntry.queueMode).toBe("steer");
  });

  it("returns usage when the message is missing", async () => {
    const params = buildParams("/followup");

    const result = await handleFollowupCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /followup <message>" },
    });
    expect(params.directives.hasQueueDirective).toBe(false);
  });
});
