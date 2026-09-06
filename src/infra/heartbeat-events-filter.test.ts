// Covers heartbeat event prompt filtering.
import { describe, expect, it } from "vitest";
import {
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
  resolveHeartbeatEventPrompt,
} from "./heartbeat-events-filter.js";

function buildHeartbeatEventPrompt(
  params: Parameters<typeof resolveHeartbeatEventPrompt>[0],
): string {
  return resolveHeartbeatEventPrompt(params).prompt;
}

describe("heartbeat event prompts", () => {
  it.each([
    {
      name: "builds user-relay cron prompt by default",
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Please relay this reminder to the user"],
      unexpected: ["Handle this reminder internally", "Reply NO_REPLY."],
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
      expected: ["Reply NO_REPLY."],
      unexpected: ["Handle this reminder internally"],
    },
    {
      name: "uses internal empty-content fallback when delivery is disabled",
      events: ["", "   "],
      opts: { deliverToUser: false },
      expected: ["Handle this internally", "NO_REPLY when nothing needs user-facing follow-up"],
      unexpected: ["Please relay this reminder to the user"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildHeartbeatEventPrompt({ cronEvents: events, ...opts });
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
      expected: ["user delivery is disabled", "Handle the result internally", "NO_REPLY only"],
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
      expected: ["no command output was found", "Reply NO_REPLY only"],
      unexpected: ["Please relay the command output to the user", "system messages above"],
    },
    {
      name: "suppresses metadata-only successful exec completions",
      events: ["Exec completed (abc12345, code 0)"],
      opts: undefined,
      expected: ["no command output was found", "Reply NO_REPLY only"],
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
    const prompt = buildHeartbeatEventPrompt({ execEvents: events, ...opts });
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it("truncates oversized user-relay exec prompt output", () => {
    const prompt = buildHeartbeatEventPrompt({
      execEvents: [`Exec finished: ${"x".repeat(8_100)}`],
    });

    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(8_500);
  });

  it("uses heartbeat_respond for empty cron events in response-tool mode", () => {
    const prompt = buildHeartbeatEventPrompt({
      cronEvents: [""],
      useHeartbeatResponseTool: true,
    });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("uses heartbeat_respond for quiet exec completion events in response-tool mode", () => {
    const prompt = buildHeartbeatEventPrompt({
      execEvents: [""],
      useHeartbeatResponseTool: true,
    });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("composes generic, exec, and cron events in one heartbeat prompt", () => {
    const prompt = buildHeartbeatEventPrompt({
      execEvents: ["Exec failed (backup, code 1) :: backup failed"],
      cronEvents: ["Cron: send the overnight report"],
      genericEvents: ["Gateway restart ok"],
    });

    expect(prompt).toContain("Multiple heartbeat events were triggered");
    expect(prompt).toContain("backup failed");
    expect(prompt).toContain("Cron: send the overnight report");
    expect(prompt).toContain("Gateway restart ok");
  });

  it("bounds mixed heartbeat event prompts with one aggregate limit", () => {
    const prompt = buildHeartbeatEventPrompt({
      execEvents: [`Exec failed (backup, code 1) :: ${"e".repeat(9_000)}`],
      cronEvents: [`Reminder: ${"c".repeat(9_000)}`],
      genericEvents: [`Gateway restart ${"g".repeat(9_000)}`],
    });

    expect(prompt.length).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("[truncated]");
    expect(prompt).toContain("An async command");
    expect(prompt).toContain("A scheduled reminder");
    expect(prompt).toContain("A system event");
  });

  it("bounds a single untagged cron event prompt", () => {
    const prompt = buildHeartbeatEventPrompt({
      cronEvents: [`Reminder: ${"c".repeat(20_000)}`],
    });

    expect(prompt.length).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("[truncated]");
    expect(prompt).toContain("Please relay this reminder to the user");
  });

  it.each([
    {
      name: "exec",
      params: {
        execEvents: [`Exec finished: ${"e".repeat(8_100)}`, "Exec finished: omitted"],
      },
      kind: "exec" as const,
      // Exec completions are consumed as a class: ordinary admission never
      // drains them, so truncated entries cannot be left without an owner.
      expected: [0, 1],
    },
    {
      name: "generic",
      params: {
        genericEvents: [`Gateway startup ${"g".repeat(8_100)}`, "Gateway restart omitted"],
      },
      kind: "generic" as const,
      expected: [0],
    },
  ])("tracks the $name entries retained by its class budget", ({ params, kind, expected }) => {
    const resolution = resolveHeartbeatEventPrompt(params);

    expect(resolution.prompt).toContain("[truncated]");
    expect(resolution.prompt).not.toContain("omitted");
    expect(resolution.handledEventIndexes[kind]).toEqual(expected);
  });

  it("tracks cron entries retained by aggregate head and tail truncation", () => {
    const resolution = resolveHeartbeatEventPrompt({
      cronEvents: [`F${"a".repeat(11_100)}`, "Middle reminder omitted", `L${"z".repeat(5_000)}`],
    });

    expect(resolution.prompt).toContain("[truncated]");
    expect(resolution.prompt).not.toContain("Middle reminder omitted");
    expect(resolution.handledEventIndexes.cron).toEqual([0, 2]);
  });

  it("keeps metadata-only exec completions explicitly handled", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: ["Exec completed (abc12345, code 0)"],
    });

    expect(resolution.prompt).toContain("no command output was found");
    expect(resolution.handledEventIndexes.exec).toEqual([0]);
  });

  it("keeps a bisected event queued when only a fragment survives truncation", () => {
    const resolution = resolveHeartbeatEventPrompt({
      cronEvents: [`F${"a".repeat(10_950)}`, "CRITICAL_RESTART_FAILURE", `L${"z".repeat(5_500)}`],
    });

    expect(resolution.prompt).toContain("[truncated]");
    expect(resolution.prompt).not.toContain("CRITICAL_RESTART_FAILURE");
    expect(resolution.handledEventIndexes.cron).toEqual([0, 2]);
  });

  it("selects the same retained events across delivery and response-tool modes", () => {
    const params = {
      execEvents: [
        "Exec completed (backup, code 0)",
        `Exec failed (restore, code 1) :: ${"e".repeat(7_900)}`,
      ],
      cronEvents: [
        `Reminder: rotate logs ${"c".repeat(7_900)}`,
        "Reminder: send the overnight report",
      ],
      genericEvents: [`Gateway restart ${"g".repeat(7_900)}`, "Gateway restart ok"],
    };
    const modes = [
      { deliverToUser: true, useHeartbeatResponseTool: false },
      { deliverToUser: false, useHeartbeatResponseTool: false },
      { deliverToUser: true, useHeartbeatResponseTool: true },
    ] as const;
    const baseline = resolveHeartbeatEventPrompt({ ...params, ...modes[0] });

    for (const mode of modes.slice(1)) {
      const resolution = resolveHeartbeatEventPrompt({ ...params, ...mode });
      expect(resolution.handledEventIndexes, `mode ${JSON.stringify(mode)}`).toEqual(
        baseline.handledEventIndexes,
      );
      expect(resolution.prompt.length).toBeLessThanOrEqual(16_000);
    }
    expect(baseline.handledEventIndexes.exec).toEqual([0, 1]);
    expect(baseline.handledEventIndexes.cron).toEqual([0, 1]);
    expect(baseline.handledEventIndexes.generic).toEqual([0, 1]);
  });

  it("reports the hidden remainder of a partially shown oversized event", () => {
    const resolution = resolveHeartbeatEventPrompt({
      genericEvents: [`Gateway startup report ${"g".repeat(12_000)}`],
    });

    expect(resolution.prompt).toContain("[truncated]");
    expect(resolution.handledEventIndexes.generic).toEqual([0]);
    expect(resolution.unseenRemainders).toHaveLength(1);
    expect(resolution.unseenRemainders[0]).toMatchObject({ kind: "generic", eventIndex: 0 });
    expect(resolution.unseenRemainders[0]?.text).toMatch(/^g+$/);
    expect(resolution.unseenRemainders[0]?.text.length).toBeGreaterThan(3_000);
  });

  it("records aggregate gaps for exec events consumed as a class", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: [
        `Exec completed (one, code 0) :: ${"a".repeat(2_900)}`,
        `Exec completed (two, code 0) :: ${"b".repeat(2_900)}`,
        `Exec completed (three, code 0) :: ${"c".repeat(2_900)}`,
      ],
      cronEvents: ["Reminder: rotate logs"],
      genericEvents: ["Gateway restart ok"],
    });

    expect(resolution.handledEventIndexes.exec).toEqual([0, 1, 2]);
    const remainderTexts = resolution.unseenRemainders
      .filter((remainder) => remainder.kind === "exec")
      .map((remainder) => remainder.text);
    expect(remainderTexts.join("").length).toBeGreaterThan(500);
    expect(remainderTexts.some((text) => text.includes("bbb"))).toBe(true);
    expect(remainderTexts.some((text) => text.includes("ccc"))).toBe(true);
    // Exactly one continuation per partially shown exec entry: the single
    // collector must not duplicate entries also consumed as a class, and the
    // fully shown first entry needs no continuation.
    expect(remainderTexts).toHaveLength(2);
  });

  it("conserves content across both truncation stages for an oversized exec event", () => {
    const event = `Exec completed (big, code 0) :: ${"Z".repeat(16_400)}`;
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: [event],
      cronEvents: ["Reminder: rotate logs"],
      genericEvents: ["Gateway restart ok"],
    });

    expect(resolution.handledEventIndexes.exec).toEqual([0]);
    expect(
      resolution.unseenRemainders.filter((remainder) => remainder.kind === "exec"),
    ).toHaveLength(1);
    const remainder = resolution.unseenRemainders.find((r) => r.kind === "exec")?.text ?? "";
    // Shown chunk + remainder covers the original output exactly once.
    const shown = (resolution.prompt.match(/Z/g) ?? []).length;
    expect(shown + (remainder.match(/Z/g) ?? []).length).toBe(16_400);
  });

  it("advances an oversized generic event across successive wakes", () => {
    const event = `Gateway status ${"Z".repeat(20_000)}`;
    const first = resolveHeartbeatEventPrompt({ genericEvents: [event] });

    // First wake surfaces a chunk and reports the exact unseen remainder.
    expect(first.handledEventIndexes.generic).toEqual([0]);
    const remainder = first.unseenRemainders.find((r) => r.kind === "generic")?.text ?? "";
    expect(remainder.length).toBeGreaterThan(1_000);
    const shown = (first.prompt.match(/Z/g) ?? []).length;
    expect(shown + remainder.length).toBe(20_000);

    // Feeding the remainder back surfaces strictly more content.
    const second = resolveHeartbeatEventPrompt({
      genericEvents: [event.slice(0, event.length - remainder.length), remainder],
    });
    const secondShown = (second.prompt.match(/Z/g) ?? []).length;
    expect(secondShown).toBeGreaterThan(0);
    const totalShownAfterTwo = shown + secondShown;
    expect(totalShownAfterTwo).toBeGreaterThan(shown);
  });

  it("keeps a full composed batch within the aggregate limit with a missing-output exec", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: [
        "Exec failed (audit, code 1)",
        `Exec completed (logs, code 0) :: ${"L".repeat(7_000)}`,
      ],
      cronEvents: [`Reminder: send the overnight report ${"R".repeat(7_000)}`],
      genericEvents: [`Gateway restart ${"G".repeat(7_000)}`],
    });

    expect(resolution.prompt.length).toBeLessThanOrEqual(16_000);
    expect(resolution.prompt).toContain("without captured stdout/stderr");
    expect(resolution.handledEventIndexes.exec).toEqual([0, 1]);
  });

  it("keeps combined truncation gaps in source order", () => {
    const resolution = resolveHeartbeatEventPrompt({
      cronEvents: ["Reminder: rotate logs"],
      genericEvents: [`${"A".repeat(7_900)}${"B".repeat(4_500)}`],
    });

    expect(resolution.prompt).toContain("[truncated]");
    const genericRemainder = resolution.unseenRemainders.find(
      (remainder) => remainder.kind === "generic",
    );
    expect(genericRemainder?.text).toMatch(/^A+B+$/);
    expect(genericRemainder?.text.length).toBeGreaterThan(4_000);
  });

  it("decides silence once for a quiet exec plus reminder batch", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: ["Exec completed (abc12345, code 0)"],
      cronEvents: ["Reminder: send the overnight report"],
      deliverToUser: true,
      useHeartbeatResponseTool: false,
    });

    expect(resolution.prompt).toContain("Reminder: send the overnight report");
    expect(resolution.prompt).toContain("no command output was found");
    expect(resolution.prompt).not.toContain("Reply NO_REPLY only");
    expect(resolution.handledEventIndexes.exec).toEqual([0]);
    expect(resolution.handledEventIndexes.cron).toEqual([0]);
    expect(
      resolution.prompt.match(/reply NO_REPLY/g)?.length ?? 0,
      "the batch completion policy mentions NO_REPLY exactly once",
    ).toBe(1);
  });

  it("keeps the silence decision for a quiet-only batch", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: ["Exec completed (abc12345, code 0)"],
      cronEvents: [""],
      deliverToUser: true,
      useHeartbeatResponseTool: false,
    });

    expect(resolution.prompt).toContain("no command output was found");
    expect(resolution.prompt).toContain("no event content was found");
    expect(resolution.prompt).toContain("Reply NO_REPLY");
    expect(resolution.handledEventIndexes.exec).toEqual([0]);
    expect(resolution.handledEventIndexes.cron).toEqual([0]);
  });

  it("decides silence once for an internal-only mixed batch", () => {
    const resolution = resolveHeartbeatEventPrompt({
      execEvents: ["Exec completed (abc12345, code 0)"],
      cronEvents: ["Reminder: send the overnight report"],
      deliverToUser: false,
      useHeartbeatResponseTool: false,
    });

    expect(resolution.prompt).toContain("Reminder: send the overnight report");
    expect(resolution.prompt).not.toContain("Please relay this reminder");
    expect(resolution.prompt).not.toContain("Reply NO_REPLY only");
    expect(resolution.prompt).toContain("reply NO_REPLY");
  });

  it("embeds generic system events in the heartbeat prompt", () => {
    const prompt = buildHeartbeatEventPrompt({ genericEvents: ["Gateway restart ok"] });

    expect(prompt).toContain("Gateway restart ok");
    expect(prompt).toContain("user-facing follow-up");
  });

  it("keeps generic system prompt output bounded", () => {
    const prompt = buildHeartbeatEventPrompt({ genericEvents: ["x".repeat(8_100)] });

    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(8_500);
  });

  it("compacts legacy heartbeat metadata in generic system prompts", () => {
    const prompt = buildHeartbeatEventPrompt({
      genericEvents: [
        "Node: connected · last input 2026-08-29T00:00:00Z",
        "heartbeat poll: noop",
        "Gateway restart ok",
      ],
    });

    expect(prompt).toContain("Node: connected");
    expect(prompt).not.toContain("last input");
    expect(prompt).not.toContain("heartbeat poll");
    expect(prompt).toContain("Gateway restart ok");
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
    { value: "NO_REPLY", expected: false },
    { value: "no_reply: actual reminder", expected: true },
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

describe("buildExecEventPrompt truncation", () => {
  it("does not split surrogate pairs in long event text", () => {
    const safePrefix = "x".repeat(7_999);
    const result = buildHeartbeatEventPrompt({ execEvents: [`${safePrefix}🚀tail`] });

    expect(result).toContain(`${safePrefix}\n\n[truncated]`);
    expect(result).not.toContain("🚀tail");
  });

  it("passes through short event text unchanged", () => {
    const result = buildHeartbeatEventPrompt({ execEvents: ["hello"] });
    expect(result).toContain("hello");
    expect(result).not.toContain("[truncated]");
  });
});
