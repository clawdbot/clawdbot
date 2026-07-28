// Chat log tests cover message rendering order and layout behavior.
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

  it("coalesces consecutive repeatable system messages", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addSystem("no active run", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain("no active run x3");
  });

  it("does not coalesce ordinary system messages", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("status unchanged");
    chatLog.addSystem("status unchanged");

    expect(chatLog.children.length).toBe(2);
  });

  it("starts a new repeatable system message after other chat content", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addUser("hello");
    chatLog.addSystem("no active run", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(3);
    expect(rendered).not.toContain("no active run x2");
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

  it("keeps cumulative assistant text in chronological order around a tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("Before the tool.\n\nAfter the tool.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    expect(rendered.indexOf("Before the tool.")).toBeLessThan(rendered.indexOf("Read File"));
    expect(rendered.indexOf("Read File")).toBeLessThan(rendered.indexOf("After the tool."));
  });

  it("does not repeat cumulative text across multiple tool calls", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("First segment.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    chatLog.startTool("tool-2", "read_file", { path: "b.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.\n\nThird segment.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    for (const text of ["First segment.", "Second segment.", "Third segment."]) {
      expect(rendered.split(text)).toHaveLength(2);
    }
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
  });

  it("reconciles revised assistant snapshots without repeating stale frozen text", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Hello before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("Hallo before the tool.\n\nRevised answer.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Hello before the tool.");
    expect(rendered.split("Hallo before the tool.")).toHaveLength(2);
    expect(rendered.split("Revised answer.")).toHaveLength(2);
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    expect(rendered.indexOf("Read File")).toBeLessThan(rendered.indexOf("Revised answer."));

    chatLog.updateAssistant("Hallo before the tool.\n\nRevised answer.\n\nNext segment.", "run-1");

    const continued = normalizeTestText(chatLog.render(120).join("\n"));
    expect(continued.indexOf("Read File")).toBeLessThan(continued.indexOf("Next segment."));
    expect(continued.split("Revised answer.")).toHaveLength(2);
  });

  it("reconciles a revised final snapshot after multiple frozen tool calls", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("First segment.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    chatLog.startTool("tool-2", "read_file", { path: "b.txt" });
    chatLog.finalizeAssistant("Revised first segment.\n\nFinal answer.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.split("Revised first segment.")).toHaveLength(2);
    expect(rendered.split("Final answer.")).toHaveLength(2);
    expect(rendered).not.toContain("Second segment.");
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "ToolExecutionComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    expect(rendered.lastIndexOf("Read File")).toBeLessThan(rendered.indexOf("Final answer."));
  });

  it("removes frozen provisional text when the final snapshot retracts it", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Retracted provisional answer.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.finalizeAssistant("", "run-1");

    expect(normalizeTestText(chatLog.render(120).join("\n"))).not.toContain(
      "Retracted provisional answer.",
    );
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "ToolExecutionComponent",
    ]);
  });

  it("removes an empty post-tool component when its final snapshot is retracted", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("Before the tool.\n\nRetracted answer.", "run-1");
    chatLog.finalizeAssistant("Before the tool.", "run-1");

    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
    ]);
    expect(normalizeTestText(chatLog.render(120).join("\n"))).not.toContain("Retracted answer.");
  });

  it("preserves indentation in assistant text that follows a tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("I ran it:", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("I ran it:\n\n    command output", "run-1");

    const segment = chatLog.children.at(-1);
    expect(segment?.constructor.name).toBe("AssistantMessageComponent");
    const rendered = normalizeTestText(segment?.render(120).join("\n") ?? "");
    expect(rendered).toContain("```");
    expect(rendered).toMatch(/\n {2}command output/);
  });

  it("finalizes only assistant text that follows an intervening tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.finalizeAssistant("Before the tool.\n\nFinal answer.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.split("Before the tool.")).toHaveLength(2);
    expect(rendered.indexOf("Read File")).toBeLessThan(rendered.indexOf("Final answer."));
  });

  it("does not add an empty final assistant segment after a tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Complete before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.finalizeAssistant("Complete before the tool.", "run-1");

    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
    ]);
  });

  it("clears frozen assistant segments when the chat history is rebuilt", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.clearAll();
    chatLog.updateAssistant("Before the tool.\n\nNew history.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Before the tool.");
    expect(rendered).toContain("New history.");
    expect(chatLog.children).toHaveLength(1);
  });

  it("removes every frozen assistant segment when a tool-using run is dropped", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("First segment.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    chatLog.startTool("tool-2", "read_file", { path: "b.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.\n\nThird segment.", "run-1");

    chatLog.dropAssistant("run-1");

    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "ToolExecutionComponent",
      "ToolExecutionComponent",
    ]);
    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("First segment.");
    expect(rendered).not.toContain("Second segment.");
    expect(rendered).not.toContain("Third segment.");

    chatLog.updateAssistant("Fresh run.", "run-1");
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Fresh run.");
  });

  it("reserves assistant position without clearing existing streamed text", () => {
    const chatLog = new ChatLog(40);
    chatLog.startAssistant("partial", "run-active");
    chatLog.reserveAssistantSlot("run-active");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("partial");
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

  it("clears visible tool entries and stale tool references", () => {
    const chatLog = new ChatLog(20);
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "done" }] });

    let rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Read File");

    chatLog.clearTools();
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "stale" }] });

    rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Read File");
    expect(rendered).not.toContain("stale");
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

  it("re-keys a pending user in place without moving its position", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("local", "queued hello", 1_000);
    chatLog.startAssistant("hi there", "r-accepted");

    expect(chatLog.rekeyPendingUser("local", "r-accepted")).toBe(true);

    const rendered = chatLog.render(120).join("\n");
    expect(rendered.indexOf("queued hello")).toBeLessThan(rendered.indexOf("hi there"));
    // The row is now addressable by the gateway-assigned runId.
    expect(chatLog.dropPendingUser("r-accepted")).toBe(true);
    expect(chatLog.countPendingUsers()).toBe(0);
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

  it("dismisses a pending system notice by runId", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingSystem("run-1", "taking longer than expected");
    let rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("taking longer than expected");

    const dismissed = chatLog.dismissPendingSystem("run-1");
    expect(dismissed).toBe(true);

    rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("taking longer than expected");
    expect(chatLog.dismissPendingSystem("run-1")).toBe(false);
  });

  it("replaces an existing pending system notice for the same runId", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingSystem("run-1", "first notice");
    chatLog.addPendingSystem("run-1", "second notice");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("first notice");
    expect(rendered).toContain("second notice");
    expect(chatLog.children.length).toBe(1);
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
