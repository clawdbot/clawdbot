import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";

describe("ChatLog", () => {
  it("caps component growth to avoid unbounded render trees", () => {
    const chatLog = new ChatLog(20);
    for (let i = 1; i <= 40; i++) {
      chatLog.addSystem(`system-${i}`);
    }

    expect(chatLog.children.length).toBe(20);
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("system-40");
    expect(rendered).not.toContain("system-1");
  });

  it("drops stale streaming references when old components are pruned", () => {
    const chatLog = new ChatLog(20);
    chatLog.startAssistant("first", "run-1");
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }

    // Should not throw if the original streaming component was pruned.
    chatLog.updateAssistant("recreated", "run-1");

    const rendered = chatLog.render(120).join("\n");
    expect(chatLog.children.length).toBe(20);
    expect(rendered).toContain("recreated");
  });

  it("does not append duplicate assistant components when a run is started twice", () => {
    const chatLog = new ChatLog(40);
    chatLog.startAssistant("first", "run-dup");
    chatLog.startAssistant("second", "run-dup");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("first");
    expect(chatLog.children.length).toBe(1);
  });

  it("drops stale tool references when old components are pruned", () => {
    const chatLog = new ChatLog(20);
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }

    // Should no-op safely after the tool component is pruned.
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "done" }] });

    expect(chatLog.children.length).toBe(20);
  });

  it("prunes system messages atomically when a non-system entry overflows the log", () => {
    const chatLog = new ChatLog(20);
    for (let i = 1; i <= 20; i++) {
      chatLog.addSystem(`system-${i}`);
    }

    chatLog.addUser("hello");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toMatch(/\bsystem-1\b/);
    expect(rendered).toMatch(/\bsystem-2\b/);
    expect(rendered).toMatch(/\bsystem-20\b/);
    expect(rendered).toContain("hello");
    expect(chatLog.children.length).toBe(20);
  });

  it("renders BTW inline and removes it when dismissed", () => {
    const chatLog = new ChatLog(40);

    chatLog.addSystem("session agent:main:main");
    chatLog.showBtw({
      question: "what is 17 * 19?",
      text: "323",
    });

    let rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("BTW: what is 17 * 19?");
    expect(rendered).toContain("323");
    expect(chatLog.hasVisibleBtw()).toBe(true);

    chatLog.dismissBtw();

    rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("BTW: what is 17 * 19?");
    expect(chatLog.hasVisibleBtw()).toBe(false);
  });

  it("preserves pending user messages across history rebuilds", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello");
    chatLog.clearAll({ preservePendingUsers: true });
    chatLog.addSystem("session agent:main:main");
    chatLog.restorePendingUsers();

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("queued hello");
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("does not append the same pending component twice when it is already mounted", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello");
    chatLog.restorePendingUsers();

    expect(chatLog.children.length).toBe(1);
    expect(chatLog.render(120).join("\n")).toContain("queued hello");
  });

  it("stops counting a pending user message once the run is committed", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "hello");
    expect(chatLog.countPendingUsers()).toBe(1);

    expect(chatLog.commitPendingUser("run-1")).toBe(true);
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(chatLog.render(120).join("\n")).toContain("hello");
  });

  it("reconciles pending users against rebuilt history using timestamps", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello", 2_000);

    expect(
      chatLog.reconcilePendingUsers([
        { text: "queued hello", timestamp: 2_100 },
        { text: "older", timestamp: 1_000 },
      ]),
    ).toEqual(["run-1"]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("reconciles pending users when the gateway clock is slightly behind the client", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello", 65_000);

    expect(chatLog.reconcilePendingUsers([{ text: "queued hello", timestamp: 20_000 }])).toEqual([
      "run-1",
    ]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("does not hide a new repeated prompt when only older history matches", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "continue", 5_000);

    expect(chatLog.reconcilePendingUsers([{ text: "continue", timestamp: -56_000 }])).toStrictEqual(
      [],
    );
    expect(chatLog.countPendingUsers()).toBe(1);
  });
});
