import { describe, expect, it } from "vitest";
import { applyDeferredFollowupToolDescriptions } from "./pi-tools.deferred-followup.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function findToolDescription(toolName: string, senderIsOwner: boolean) {
  const tools = applyDeferredFollowupToolDescriptions([
    { name: "exec", description: "exec base" },
    { name: "process", description: "process base" },
    ...(senderIsOwner ? [{ name: "cron", description: "cron base" }] : []),
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
      "Execute shell commands with background continuation for work that starts now. Use yieldMs/background to continue later via process tool. For long-running work started now, rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion. Use process whenever you need logs, status, input, or intervention. Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    );
    expect(process.description).toBe(
      "Manage running exec sessions for commands already started: list, poll, log, write, send-keys, submit, paste, kill. Use poll/log when you need status, logs, quiet-success confirmation, or completion confirmation when automatic completion wake is unavailable. Use poll/log also for input-wait hints. Use write/send-keys/submit/paste/kill for input or intervention. Do not use process polling to emulate timers or reminders; use cron for scheduled follow-ups.",
    );
  });

  it("drops cron-specific guidance when cron is unavailable", () => {
    const exec = findToolDescription("exec", false);
    const process = findToolDescription("process", false);

    expect(exec.toolNames).toEqual(["exec", "process"]);
    expect(exec.description).toBe(
      "Execute shell commands with background continuation for work that starts now. Use yieldMs/background to continue later via process tool. For long-running work started now, rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion. Use process whenever you need logs, status, input, or intervention. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    );
    expect(process.description).toBe(
      "Manage running exec sessions for commands already started: list, poll, log, write, send-keys, submit, paste, kill. Use poll/log when you need status, logs, quiet-success confirmation, or completion confirmation when automatic completion wake is unavailable. Use poll/log also for input-wait hints. Use write/send-keys/submit/paste/kill for input or intervention.",
    );
  });
});
