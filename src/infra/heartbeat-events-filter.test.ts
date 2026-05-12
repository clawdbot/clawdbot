import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it.each([
    {
      name: "builds user-relay cron prompt by default",
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Please relay this reminder to the user"],
      unexpected: ["Handle this reminder internally", "Reply HEARTBEAT_OK."],
    },
    {
      name: "builds internal-only cron prompt when delivery is disabled",
      events: ["Cron: rotate logs"],
      opts: { deliverToUser: false },
      expected: ["Cron: rotate logs", "Handle this reminder internally"],
      unexpected: ["Please relay this reminder to the user"],
    },
    {
      name: "falls back to bare heartbeat reply when cron content is empty",
      events: ["", "   "],
      expected: ["Reply HEARTBEAT_OK."],
      unexpected: ["Handle this reminder internally"],
    },
    {
      name: "uses internal empty-content fallback when delivery is disabled",
      events: ["", "   "],
      opts: { deliverToUser: false },
      expected: ["Handle this internally", "HEARTBEAT_OK when nothing needs user-facing follow-up"],
      unexpected: ["Please relay this reminder to the user"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildCronEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it.each([
    {
      name: "builds user-relay exec prompt by default",
      events: ["Exec finished (node=abc id=123, code 0)\nUploaded file"],
      opts: undefined,
      expected: [
        "Exec finished",
        "Uploaded file",
        "Please relay the command output to the user",
        "If it failed",
      ],
      unexpected: ["system messages above", "Handle the result internally"],
    },
    {
      name: "builds internal-only exec prompt when delivery is disabled",
      events: ["Exec failed (node=abc id=123, code 1)\nUpload failed"],
      opts: { deliverToUser: false },
      expected: ["user delivery is disabled", "Handle the result internally", "HEARTBEAT_OK only"],
      unexpected: [
        "Upload failed",
        "system messages above",
        "Please relay the command output to the user",
      ],
    },
    {
      name: "suppresses empty exec completion prompts",
      events: ["", "   "],
      opts: undefined,
      expected: ["no command output was found", "Reply HEARTBEAT_OK only"],
      unexpected: ["Please relay the command output to the user", "system messages above"],
    },
    {
      name: "suppresses metadata-only successful exec completions",
      events: ["Exec completed (abc12345, code 0)"],
      opts: undefined,
      expected: ["no command output was found", "Reply HEARTBEAT_OK only"],
      unexpected: ["Please relay the command output to the user", "abc12345"],
    },
    {
      name: "reports metadata-only failed exec completions without asking for logs",
      events: ["Exec failed (abc12345, code 1)"],
      opts: undefined,
      expected: [
        "without captured stdout/stderr",
        "include the exit status or signal",
        "Do not ask the user to provide missing logs",
      ],
      unexpected: ["Please relay the command output to the user"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildExecEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it("truncates oversized user-relay exec prompt output", () => {
    const prompt = buildExecEventPrompt([`Exec finished: ${"x".repeat(8_100)}`]);

    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(8_500);
  });

  it("uses heartbeat_respond for empty cron events in response-tool mode", () => {
    const prompt = buildCronEventPrompt([""], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("uses heartbeat_respond for quiet exec completion events in response-tool mode", () => {
    const prompt = buildExecEventPrompt([""], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "exec finished: ok", expected: true },
    { value: "Exec finished (node=abc, code 0)", expected: true },
    { value: "Exec Finished (node=abc, code 1)", expected: true },
    { value: "Exec completed (abc12345, code 0)", expected: true },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: true },
    { value: "Exec failed (abc12345, code 1)", expected: true },
    { value: "Exec failed (abc12345, signal SIGTERM) :: error output", expected: true },
    { value: "Exec completed (rotate api keys)", expected: false },
    { value: "Exec failed: notify me if this happens", expected: false },
    { value: "Reminder: if exec failed, notify me", expected: false },
    { value: "cron finished", expected: false },
  ])("classifies exec completion events for %j", ({ value, expected }) => {
    expect(isExecCompletionEvent(value)).toBe(expected);
  });

  it.each([
    { value: "Cron: rotate logs", expected: true },
    { value: "  Cron: rotate logs  ", expected: true },
    { value: "", expected: false },
    { value: "   ", expected: false },
    { value: "HEARTBEAT_OK", expected: false },
    { value: "heartbeat_ok: already handled", expected: false },
    { value: "heartbeat poll: noop", expected: false },
    { value: "heartbeat wake: noop", expected: false },
    { value: "exec finished: ok", expected: false },
    { value: "Exec finished (node=abc, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: false },
    { value: "Exec failed (abc12345, code 1)", expected: false },
    { value: "Exec failed (abc12345, signal SIGTERM) :: error output", expected: false },
    { value: "Exec completed (rotate api keys)", expected: true },
    { value: "Reminder: if exec failed, notify me", expected: true },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent(value)).toBe(expected);
  });

  it.each([
    { value: "Exec completed (abc12345, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: true },
    { value: "Exec failed (abc12345, code 1)", expected: true },
    { value: "Exec failed (abc12345, signal SIGTERM)", expected: true },
    { value: "exec finished: ok", expected: true },
  ])("classifies relayable exec completion events for %j", ({ value, expected }) => {
    expect(isRelayableExecCompletionEvent(value)).toBe(expected);
  });
});

describe("isExecCompletionEvent", () => {
  it("matches emitExecSystemEvent (gateway/node approval path) events", () => {
    expect(isExecCompletionEvent("Exec finished (gateway id=g1, session=s1, code 0)")).toBe(true);
    expect(isExecCompletionEvent("exec finished (node=n1, code 1)\nsome output")).toBe(true);
  });

  it("matches maybeNotifyOnExit (backgrounded allowlisted commands) events", () => {
    // Word-based session slugs (createSessionSlug)
    expect(isExecCompletionEvent("Exec completed (amber-at, code 0) :: some output")).toBe(true);
    expect(isExecCompletionEvent("Exec completed (calm-del, code 0)")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (brisk-no, code 1) :: error text")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (fresh-ke, signal SIGTERM)")).toBe(true);
    // Hex-style IDs also accepted
    expect(isExecCompletionEvent("Exec completed (abc12345, code 0)")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExecCompletionEvent("EXEC COMPLETED (abc12345, code 0)")).toBe(true);
    expect(isExecCompletionEvent("exec failed (abc12345, code 2)")).toBe(true);
  });

  it("does not match non-exec events", () => {
    expect(isExecCompletionEvent("Exec running (gateway id=g1, session=s1, >5s): ls")).toBe(false);
    expect(isExecCompletionEvent("Exec denied (gateway id=g1, reason): rm -rf /")).toBe(false);
    expect(isExecCompletionEvent("Heartbeat wake")).toBe(false);
    expect(isExecCompletionEvent("")).toBe(false);
  });

  it("does not false-positive on free-form cron text containing exec phrases", () => {
    expect(isExecCompletionEvent("Nightly backup exec failed – see logs")).toBe(false);
    expect(isExecCompletionEvent("Cron: check if exec completed successfully")).toBe(false);
    expect(isExecCompletionEvent("exec killed the process manually")).toBe(false);
    expect(isExecCompletionEvent("Exec finished weekly backup checks")).toBe(false);
    // Parenthesized false positive from review feedback — must not match mid-string
    expect(isExecCompletionEvent("Nightly backup exec failed (see logs)")).toBe(false);
    expect(isExecCompletionEvent("Check: exec completed (last run was yesterday)")).toBe(false);
  });
});
