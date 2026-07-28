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

  it("preserves live users when same-session history is rebuilt from a stale snapshot", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Already persisted in history.", { messageId: "history-user" });
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Sent from the other client.");
    expect(rendered.indexOf("Already persisted in history.")).toBeLessThan(
      rendered.indexOf("Sent from the other client."),
    );
    expect(chatLog.children).toHaveLength(2);
  });

  it("does not resurrect historical users omitted by the authoritative history snapshot", () => {
    const chatLog = new ChatLog(40);

    chatLog.addUser("Deleted historical prompt.", {
      messageId: "deleted-history-user",
      messageSeq: 1,
    });
    chatLog.addLiveUser("New authoritative live prompt.", {
      messageId: "live-user",
      messageSeq: 3,
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Current authoritative history.", {
      messageId: "current-history-user",
      messageSeq: 2,
    });
    chatLog.restoreLiveUsers(4);
    chatLog.finalizeAssistant("Current authoritative reply.");
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Deleted historical prompt.");
    expect(rendered.match(/New authoritative live prompt\./g)).toHaveLength(1);
    expect(rendered.indexOf("New authoritative live prompt.")).toBeLessThan(
      rendered.indexOf("Current authoritative reply."),
    );
  });

  it("stops restoring live users after authoritative history adopts their identity", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Adopted live prompt.", {
      messageId: "adopted-user",
      messageSeq: 1,
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Adopted live prompt.", {
      messageId: "adopted-user",
      messageSeq: 1,
    });
    chatLog.restoreLiveUsers();

    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Replacement branch prompt.", {
      messageId: "replacement-user",
      messageSeq: 2,
    });
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Replacement branch prompt.");
    expect(rendered).not.toContain("Adopted live prompt.");
  });

  it("restores a missing canonical user before its higher-sequence persisted reply", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Authoritative shared prompt.", {
      messageId: "shared-user",
      messageSeq: 1,
      runId: "shared-run",
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addSystem("session agent:main:main");
    chatLog.restoreLiveUsers(2);
    chatLog.finalizeAssistant("Already persisted reply.");
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.match(/Authoritative shared prompt\./g)).toHaveLength(1);
    expect(rendered.indexOf("Authoritative shared prompt.")).toBeLessThan(
      rendered.indexOf("Already persisted reply."),
    );
  });

  it("restores live canonical users only before higher-sequence history rows", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("First missing prompt.", {
      messageId: "shared-user-2",
      messageSeq: 2,
    });
    chatLog.addLiveUser("Second missing prompt.", {
      messageId: "shared-user-4",
      messageSeq: 4,
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("First persisted prompt.", {
      messageId: "history-user-1",
      messageSeq: 1,
    });
    chatLog.restoreLiveUsers(3);
    chatLog.addUser("Third persisted prompt.", {
      messageId: "history-user-3",
      messageSeq: 3,
    });
    chatLog.restoreLiveUsers(5);
    chatLog.finalizeAssistant("Fifth persisted reply.");
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    const messages = [
      "First persisted prompt.",
      "First missing prompt.",
      "Third persisted prompt.",
      "Second missing prompt.",
      "Fifth persisted reply.",
    ];
    let previousMessage: string | undefined;
    for (const message of messages) {
      if (previousMessage !== undefined) {
        expect(rendered.indexOf(previousMessage)).toBeLessThan(rendered.indexOf(message));
      }
      previousMessage = message;
    }
  });

  it("does not restore a live user already included in rebuilt authoritative history", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Original live prompt.", {
      messageId: "shared-user",
      runId: "shared-run",
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Authoritative persisted prompt.", { messageId: "shared-user" });
    chatLog.restoreLiveUsers();

    let rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Authoritative persisted prompt.");
    expect(rendered).not.toContain("Original live prompt.");
    expect(chatLog.children).toHaveLength(1);

    chatLog.addLiveUser("Updated persisted prompt.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Updated persisted prompt.");
    expect(rendered).not.toContain("Authoritative persisted prompt.");
    expect(chatLog.children).toHaveLength(1);
  });

  it("restores multiple live users in canonical event order", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("First shared prompt.", {
      messageId: "shared-user-1",
      runId: "shared-run-1",
    });
    chatLog.addLiveUser("Second shared prompt.", {
      messageId: "shared-user-2",
      runId: "shared-run-2",
    });
    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.addUser("Already persisted in history.", { messageId: "history-user" });
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.indexOf("Already persisted in history.")).toBeLessThan(
      rendered.indexOf("First shared prompt."),
    );
    expect(rendered.indexOf("First shared prompt.")).toBeLessThan(
      rendered.indexOf("Second shared prompt."),
    );
    expect(chatLog.children).toHaveLength(3);
  });

  it("restores both live and pending users across a same-session history rebuild", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });
    chatLog.addPendingUser("local-run", "My pending prompt.");
    chatLog.clearAll({ preserveLiveUsers: true, preservePendingUsers: true });
    chatLog.addUser("Already persisted in history.", { messageId: "history-user" });
    chatLog.restoreLiveUsers();
    chatLog.restorePendingUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Sent from the other client.");
    expect(rendered).toContain("My pending prompt.");
    expect(chatLog.countPendingUsers()).toBe(1);
    expect(chatLog.children).toHaveLength(3);
  });

  it.each([
    { clear: "session switch", options: undefined },
    { clear: "pending-only rebuild", options: { preservePendingUsers: true } },
  ])("does not leak live users after a $clear", ({ options }) => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("A previous session's prompt.", {
      messageId: "previous-session-user",
      runId: "previous-session-run",
    });
    chatLog.clearAll(options);
    chatLog.addUser("Current session history.", { messageId: "current-session-user" });
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Current session history.");
    expect(rendered).not.toContain("A previous session's prompt.");
    expect(chatLog.children).toHaveLength(1);
  });

  it("does not append the same pending component twice when it is already mounted", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello");
    chatLog.restorePendingUsers();

    expect(chatLog.children.length).toBe(1);
    expect(chatLog.render(120).join("\n")).toContain("queued hello");
  });

  it("inserts another client's persisted prompt ahead of an already-streaming reply", () => {
    const chatLog = new ChatLog(40);
    chatLog.updateAssistant("Already streaming.", "shared-run");

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.indexOf("Sent from the other client.")).toBeLessThan(
      rendered.indexOf("Already streaming."),
    );
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "UserMessageComponent",
      "AssistantMessageComponent",
    ]);

    chatLog.updateAssistant("Still streaming.", "shared-run");
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Still streaming.");
  });

  it("preserves a delayed shared prompt and its active reply when scrollback is full", () => {
    const chatLog = new ChatLog(20);
    chatLog.updateAssistant("Already streaming.", "shared-run");
    for (let index = 0; index < 19; index += 1) {
      chatLog.addSystem(`Older notice ${index}.`);
    }

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-overflow-user",
      runId: "shared-run",
    });
    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-overflow-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).toContain("Sent from the other client.");
    expect(rendered).toContain("Already streaming.");
    expect(rendered).not.toContain("Older notice 0.");
    expect(rendered.match(/Sent from the other client\./g)).toHaveLength(1);
    expect(rendered.indexOf("Sent from the other client.")).toBeLessThan(
      rendered.indexOf("Already streaming."),
    );

    chatLog.updateAssistant("Still streaming after overflow.", "shared-run");
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain(
      "Still streaming after overflow.",
    );
  });

  it("preserves a delayed shared prompt and its streaming reply at the scrollback limit", () => {
    const chatLog = new ChatLog(20);
    chatLog.startAssistant("Already streaming.", "shared-run");
    for (let index = 0; index < 19; index += 1) {
      chatLog.addSystem(`notice-${index}`);
    }

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    let rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).toContain("Sent from the other client.");
    expect(rendered.indexOf("Sent from the other client.")).toBeLessThan(
      rendered.indexOf("Already streaming."),
    );

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });
    chatLog.updateAssistant("Still streaming.", "shared-run");

    rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered.match(/Sent from the other client\./g)).toHaveLength(1);
    expect(rendered.indexOf("Sent from the other client.")).toBeLessThan(
      rendered.indexOf("Still streaming."),
    );
  });

  it("evicts an unrelated older tool instead of a newer transcript row at full scrollback", () => {
    const chatLog = new ChatLog(20);
    chatLog.startTool("unrelated-old-tool", "read_file", { path: "unrelated-old.txt" });
    chatLog.startAssistant("Current streaming reply.", "shared-run");
    for (let index = 0; index < 18; index += 1) {
      chatLog.addSystem(`newer-notice-${index}`);
    }

    chatLog.addLiveUser("Current authoritative prompt.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Read File");
    expect(rendered).toContain("newer-notice-0");
    expect(rendered).toContain("Current streaming reply.");
    expect(rendered.indexOf("Current authoritative prompt.")).toBeLessThan(
      rendered.indexOf("Current streaming reply."),
    );
  });

  it("preserves a delayed shared prompt, frozen reply, and tool at the scrollback limit", () => {
    const chatLog = new ChatLog(20);
    chatLog.startAssistant("Before the tool.", "shared-run");
    chatLog.startTool("shared-tool", "read_file", { path: "shared.txt" });
    for (let index = 0; index < 18; index += 1) {
      chatLog.addSystem(`notice-${index}`);
    }

    chatLog.addLiveUser("Sent from the other client.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).toContain("Sent from the other client.");
    expect(rendered).toContain("Before the tool.");
    expect(rendered).toContain("Read File");
    expect(rendered.indexOf("Sent from the other client.")).toBeLessThan(
      rendered.indexOf("Before the tool."),
    );
    expect(rendered.indexOf("Before the tool.")).toBeLessThan(rendered.indexOf("Read File"));
  });

  it("keeps scrollback bounded when every visible tool belongs to the delayed prompt's run", () => {
    const chatLog = new ChatLog(20);
    chatLog.startAssistant("Reply with many tools.", "shared-run");
    for (let index = 0; index < 19; index += 1) {
      chatLog.startTool(
        `shared-tool-${index}`,
        "read_file",
        { path: `shared-${index}.txt` },
        "shared-run",
      );
    }

    chatLog.addLiveUser("Authoritative prompt before many tools.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered.match(/Authoritative prompt before many tools\./g)).toHaveLength(1);
    expect(rendered.indexOf("Authoritative prompt before many tools.")).toBeLessThan(
      rendered.indexOf("Reply with many tools."),
    );
    expect(rendered).not.toContain("shared-0.txt");
    expect(rendered).toContain("shared-18.txt");

    chatLog.updateToolResult("shared-tool-0", {
      content: [{ type: "text", text: "evicted tool must stay detached" }],
    });
    expect(chatLog.children).toHaveLength(20);
    expect(chatLog.render(120).join("\n")).not.toContain("evicted tool must stay detached");
  });

  it("deduplicates authoritative user events and adopts the matching pending prompt", () => {
    const chatLog = new ChatLog(40);
    chatLog.addPendingUser("shared-run", "Persisted prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");

    chatLog.addLiveUser("Persisted prompt.", { messageId: "shared-user", runId: "shared-run" });
    chatLog.addLiveUser("Persisted prompt.", { messageId: "shared-user", runId: "shared-run" });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Persisted prompt.");
    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "UserMessageComponent",
      "AssistantMessageComponent",
    ]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("preserves a different pending prompt when another client uses the same run", () => {
    const chatLog = new ChatLog(40);
    chatLog.addPendingUser("shared-run", "My local steering prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");

    chatLog.addLiveUser("Another client's persisted prompt.", {
      messageId: "shared-remote-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("My local steering prompt.");
    expect(rendered).toContain("Another client's persisted prompt.");
    expect(rendered.indexOf("Another client's persisted prompt.")).toBeLessThan(
      rendered.indexOf("Already streaming."),
    );
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("deduplicates a replayed live prompt already loaded from authoritative history", () => {
    const chatLog = new ChatLog(40);
    chatLog.addUser("Loaded from history.", { messageId: "history-user" });

    chatLog.addLiveUser("Loaded from history.", {
      messageId: "history-user",
      runId: "history-run",
    });

    expect(chatLog.children.map((component) => component.constructor.name)).toEqual([
      "UserMessageComponent",
    ]);
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Loaded from history.");
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
