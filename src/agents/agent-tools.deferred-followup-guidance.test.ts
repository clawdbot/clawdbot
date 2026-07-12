/**
 * Tests cron-aware deferred follow-up guidance in exec/process descriptions.
 * Protects the model-facing text selected after tool filtering.
 */
import { describe, expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tools.js";
import { applyDeferredFollowupToolDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";

function findToolDescription(toolName: string, includeCron: boolean) {
  const tools = applyDeferredFollowupToolDescriptions([
    { name: "exec", description: "exec base" },
    { name: "process", description: "process base" },
    ...(includeCron ? [{ name: "cron", description: "cron base" }] : []),
  ] as AnyAgentTool[]);
  const tool = tools.find((entry) => entry.name === toolName);
  return {
    toolNames: tools.map((entry) => entry.name),
    description: tool?.description ?? "",
  };
}

describe("createOpenClawCodingTools deferred follow-up guidance", () => {
  it("keeps cron-specific guidance when cron survives filtering", () => {
    const exec = findToolDescription("exec", true);
    const process = findToolDescription("process", true);

    expect(exec.toolNames).toEqual(["exec", "process", "cron"]);
    expect(exec.description).toBe(
      "Run shell now; background continuation supported. Use yieldMs/background, then process for logs/status/input/intervention. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. No sleep/delay loops for reminders/follow-ups; use cron. TTY CLI/UI/coding agent: pty=true.",
    );
    expect(process.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention. No polling as timer/reminder; scheduled follow-up uses cron.",
    );
  });

  it("drops cron-specific guidance when cron is unavailable", () => {
    const exec = findToolDescription("exec", false);
    const process = findToolDescription("process", false);

    expect(exec.toolNames).toEqual(["exec", "process"]);
    expect(exec.description).toBe(
      "Run shell now; background continuation supported. Use yieldMs/background, then process for logs/status/input/intervention. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. TTY CLI/UI/coding agent: pty=true.",
    );
    expect(process.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention.",
    );
  });

  it("preserves ownership metadata when replacing process descriptions", () => {
    const processTool = {
      name: "process",
      description: "plugin process",
    } as AnyAgentTool;
    setPluginToolMeta(processTool, { pluginId: "example", optional: false });
    setChannelAgentToolMeta(processTool as never, { channelId: "example-channel" });

    const [updated] = applyDeferredFollowupToolDescriptions([processTool]);

    expect(updated).not.toBe(processTool);
    expect(getPluginToolMeta(updated)).toEqual({ pluginId: "example", optional: false });
    expect(getChannelAgentToolMeta(updated as never)).toEqual({
      channelId: "example-channel",
    });
  });
});
