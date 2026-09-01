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

  it("sanitizes terminal controls before rendering an initial system message", () => {
    const chatLog = new ChatLog(20);
    const sgr = "\x1b[38;5;201mcolor";
    const erase = "\x1b[3Jerase";
    const osc52 = "\x1b]52;c;T08_CHAT_LOG_CLIPBOARD\x07";
    const c1Csi = "\u009b3Jc1";
    const c1Osc = "\u009d0;T08_CHAT_LOG_TITLE\u009c";

    chatLog.addSystem(`before ${sgr}\x1b[0m ${erase} ${osc52}${c1Csi} ${c1Osc}after`);

    const raw = chatLog.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).toContain("before color erase c1 after");
    for (const attack of [sgr, erase, osc52, c1Csi, c1Osc]) {
      expect(raw).not.toContain(attack);
    }
  });

  it("coalesces consecutive repeatable system messages", () => {
    const chatLog = new ChatLog(20);
    const rawText = "\x1b[?7777h\x1b]52;c;T08_CHAT_LOG_ONLY_CONTROLS\x07";

    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });

    const raw = chatLog.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain("(no output) x3");
    expect(raw).not.toContain(rawText);
  });

  it("does not coalesce distinct raw system messages that sanitize identically", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("\x1b[?7776h", { coalesceConsecutive: true });
    chatLog.addSystem("\u009b777;888H", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(2);
    expect(rendered.match(/\(no output\)/g)).toHaveLength(2);
    expect(rendered).not.toContain("x2");
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

  it("updates an existing canonical user component without appending another row", () => {
    const chatLog = new ChatLog(40);

    chatLog.addUser("Original authoritative prompt.", { messageId: "shared-user" });
    chatLog.addUser("Updated authoritative prompt.", { messageId: "shared-user" });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(1);
    expect(rendered).toContain("Updated authoritative prompt.");
    expect(rendered).not.toContain("Original authoritative prompt.");
  });

  it("clears user and pending component references before the next projected session", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Previous session prompt.", { messageId: "previous-user" });
    chatLog.addPendingUser("previous-run", "Previous pending prompt.");
    chatLog.clearAll();
    chatLog.addUser("Selected session prompt.", { messageId: "selected-user" });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Selected session prompt.");
    expect(rendered).not.toContain("Previous session prompt.");
    expect(rendered).not.toContain("Previous pending prompt.");
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(chatLog.children).toHaveLength(1);
  });

  it("updates a pending viewport component in place for the same run", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "Original pending prompt.");
    chatLog.addPendingUser("run-1", "Updated pending prompt.");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(1);
    expect(chatLog.countPendingUsers()).toBe(1);
    expect(rendered).toContain("Updated pending prompt.");
    expect(rendered).not.toContain("Original pending prompt.");
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

  it.each([
    { phase: "streaming", capacity: 20 },
    { phase: "streaming", capacity: 40 },
    { phase: "finished", capacity: 20 },
    { phase: "finished", capacity: 40 },
    { phase: "tool-streaming", capacity: 20 },
    { phase: "tool-streaming", capacity: 40 },
    { phase: "tool-finished", capacity: 20 },
    { phase: "tool-finished", capacity: 40 },
    { phase: "tool-finished-direct", capacity: 20 },
    { phase: "tool-finished-direct", capacity: 40 },
    { phase: "tool-finished-no-tail", capacity: 20 },
    { phase: "tool-finished-no-tail", capacity: 40 },
    { phase: "tool-finished-retracted-tail", capacity: 20 },
    { phase: "tool-finished-retracted-tail", capacity: 40 },
  ])(
    "orders a delayed prompt before a $phase reply at capacity $capacity",
    ({ phase, capacity }) => {
      const chatLog = new ChatLog(capacity);
      const runId = `shared-${phase}-${capacity}`;
      chatLog.updateAssistant("First reply segment.", runId);

      if (phase.startsWith("tool-")) {
        chatLog.startTool(`${runId}-tool`, "read_file", { path: "shared.txt" });
        if (
          phase === "tool-streaming" ||
          phase === "tool-finished" ||
          phase === "tool-finished-retracted-tail"
        ) {
          chatLog.updateAssistant("First reply segment.\n\nLast reply segment.", runId);
        }
      }
      if (phase === "finished" || phase.startsWith("tool-finished")) {
        chatLog.finalizeAssistant(
          phase.startsWith("tool-") &&
            phase !== "tool-finished-no-tail" &&
            phase !== "tool-finished-retracted-tail"
            ? "First reply segment.\n\nLast reply segment."
            : "First reply segment.",
          runId,
        );
      }
      while (chatLog.children.length < capacity) {
        chatLog.addSystem(`Old notice ${chatLog.children.length}.`);
      }

      const prompt = { messageId: `${runId}-user`, runId };
      chatLog.addLiveUser("Authoritative shared prompt.", prompt);
      chatLog.addLiveUser("Authoritative shared prompt.", prompt);

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Authoritative shared prompt\./g)).toHaveLength(1);
      expect(rendered.indexOf("Authoritative shared prompt.")).toBeLessThan(
        rendered.indexOf("First reply segment."),
      );
      if (
        phase.startsWith("tool-") &&
        phase !== "tool-finished-no-tail" &&
        phase !== "tool-finished-retracted-tail"
      ) {
        expect(rendered).toContain("Last reply segment.");
      }
    },
  );

  it.each([
    { capacity: 20, eviction: "first-assistant", evictedComponents: 1 },
    { capacity: 40, eviction: "first-assistant", evictedComponents: 1 },
    { capacity: 20, eviction: "all-assistants", evictedComponents: 3 },
    { capacity: 40, eviction: "all-assistants", evictedComponents: 3 },
  ])(
    "orders a delayed prompt before owned tools after $eviction eviction at capacity $capacity",
    ({ capacity, eviction, evictedComponents }) => {
      const chatLog = new ChatLog(capacity);
      const runId = `evicted-${eviction}-${capacity}`;

      chatLog.updateAssistant("First evicted reply segment.", runId);
      chatLog.startTool(`${runId}-first-tool`, "read_file", { path: "first-shared.txt" }, runId);
      chatLog.updateAssistant("First evicted reply segment.\n\nLast evicted reply segment.", runId);
      chatLog.startTool(`${runId}-last-tool`, "read_file", { path: "last-shared.txt" }, runId);
      chatLog.finalizeAssistant(
        "First evicted reply segment.\n\nLast evicted reply segment.",
        runId,
      );

      while (chatLog.children.length < capacity) {
        chatLog.addSystem(`Retained notice ${chatLog.children.length}.`);
      }
      for (let index = 0; index < evictedComponents; index += 1) {
        chatLog.addSystem(`Evicting notice ${index}.`);
      }

      const prompt = { messageId: `${runId}-user`, runId };
      chatLog.addLiveUser("Delayed prompt before surviving tools.", prompt);
      chatLog.addLiveUser("Delayed prompt before surviving tools.", prompt);

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Delayed prompt before surviving tools\./g)).toHaveLength(1);
      expect(rendered.indexOf("Delayed prompt before surviving tools.")).toBeLessThan(
        rendered.indexOf("last-shared.txt"),
      );
      if (eviction === "first-assistant") {
        expect(rendered.indexOf("Delayed prompt before surviving tools.")).toBeLessThan(
          rendered.indexOf("first-shared.txt"),
        );
        expect(rendered).toContain("Last evicted reply segment.");
      } else {
        expect(rendered).not.toContain("Last evicted reply segment.");
      }
    },
  );

  it.each([20, 40])(
    "reserves a delayed prompt slot when one run fills all %i scrollback components",
    (capacity) => {
      const chatLog = new ChatLog(capacity);
      const runId = `full-run-${capacity}`;
      let assistantText = "";

      for (let index = 0; index < capacity; index += 1) {
        assistantText += `${index === 0 ? "" : "\n\n"}Assistant segment ${index}.`;
        chatLog.updateAssistant(assistantText, runId);
        if (index < capacity - 1) {
          chatLog.startTool(
            `${runId}-tool-${index}`,
            "read_file",
            { path: `segment-${index}.txt` },
            runId,
          );
          chatLog.clearTools();
        }
      }
      chatLog.finalizeAssistant(assistantText, runId);

      const prompt = { messageId: `${runId}-user`, runId };
      chatLog.addLiveUser("Delayed prompt before a full reply.", prompt);
      chatLog.addLiveUser("Delayed prompt before a full reply.", prompt);

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Delayed prompt before a full reply\./g)).toHaveLength(1);
      expect(rendered.indexOf("Delayed prompt before a full reply.")).toBeLessThan(
        rendered.indexOf("Assistant segment 0."),
      );
      expect(rendered).toContain(`Assistant segment ${capacity - 1}.`);
    },
  );

  it.each([20, 40])(
    "retains an executing tool while reserving a delayed prompt at capacity %i",
    (capacity) => {
      const chatLog = new ChatLog(capacity);
      const runId = `active-tool-${capacity}`;
      let assistantText = "";

      for (let index = 0; index < capacity - 1; index += 1) {
        assistantText += `${index === 0 ? "" : "\n\n"}Running reply segment ${index}.`;
        chatLog.updateAssistant(assistantText, runId);
        chatLog.startTool(
          `${runId}-previous-tool-${index}`,
          "read_file",
          { path: `previous-${index}.txt` },
          runId,
        );
        chatLog.clearTools();
      }

      const activeToolId = `${runId}-active-tool`;
      chatLog.startTool(activeToolId, "read_file", { path: "still-running.txt" }, runId);
      chatLog.addLiveUser("Delayed prompt during active tool.", {
        messageId: `${runId}-user`,
        runId,
      });
      chatLog.updateToolResult(
        activeToolId,
        { content: [{ type: "text", text: "Visible partial tool output." }] },
        { partial: true },
      );

      let rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered).toContain("Visible partial tool output.");
      expect(rendered.indexOf("Delayed prompt during active tool.")).toBeLessThan(
        rendered.indexOf("Running reply segment 0."),
      );

      chatLog.updateToolResult(activeToolId, {
        content: [{ type: "text", text: "Visible final tool output." }],
      });
      rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(rendered).toContain("Visible final tool output.");
      expect(chatLog.children).toHaveLength(capacity);
    },
  );

  it.each([20, 40])(
    "preserves both a streaming reply and an executing tool at full capacity %i",
    (capacity) => {
      const chatLog = new ChatLog(capacity);
      const runId = `live-components-${capacity}`;
      chatLog.updateAssistant("First preserved live reply.", runId);

      const activeToolId = `${runId}-active-tool`;
      for (let index = 0; index < capacity - 2; index += 1) {
        const toolId = index === 0 ? activeToolId : `${runId}-completed-tool-${index}`;
        chatLog.startTool(toolId, "read_file", { path: `live-tool-${index}.txt` }, runId);
        if (index > 0) {
          chatLog.updateToolResult(toolId, {
            content: [{ type: "text", text: `Completed historical tool ${index}.` }],
          });
        }
      }
      chatLog.updateAssistant(
        "First preserved live reply.\n\nStreaming reply remains visible.",
        runId,
      );

      chatLog.addLiveUser("Delayed prompt during live components.", {
        messageId: `${runId}-user`,
        runId,
      });
      chatLog.updateToolResult(
        activeToolId,
        { content: [{ type: "text", text: "Live tool progress remains visible." }] },
        { partial: true },
      );
      chatLog.updateAssistant("First preserved live reply.\n\nUpdated streaming reply.", runId);

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Delayed prompt during live components\./g)).toHaveLength(1);
      expect(rendered.indexOf("Delayed prompt during live components.")).toBeLessThan(
        rendered.indexOf("First preserved live reply."),
      );
      expect(rendered).toContain("Live tool progress remains visible.");
      expect(rendered).toContain("Updated streaming reply.");
      expect(rendered).not.toContain("Completed historical tool 1.");
    },
  );

  it.each([20, 40])(
    "evicts a completed first segment before an executing tool at capacity %i",
    (capacity) => {
      const chatLog = new ChatLog(capacity);
      const runId = `only-completed-anchor-${capacity}`;
      chatLog.updateAssistant("Only completed reply segment.", runId);

      for (let index = 0; index < capacity - 2; index += 1) {
        chatLog.startTool(
          `${runId}-active-tool-${index}`,
          "read_file",
          { path: `active-only-${index}.txt` },
          runId,
        );
      }
      chatLog.updateAssistant("Only completed reply segment.\n\nProtected live reply.", runId);
      chatLog.addLiveUser("Delayed prompt before concurrent tools.", {
        messageId: `${runId}-user`,
        runId,
      });

      for (const index of [0, capacity - 3]) {
        chatLog.updateToolResult(
          `${runId}-active-tool-${index}`,
          { content: [{ type: "text", text: `Protected active tool ${index}.` }] },
          { partial: true },
        );
      }

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Delayed prompt before concurrent tools\./g)).toHaveLength(1);
      expect(rendered).not.toContain("Only completed reply segment.");
      expect(rendered).toContain("Protected live reply.");
      expect(rendered).toContain("Protected active tool 0.");
      expect(rendered).toContain(`Protected active tool ${capacity - 3}.`);
    },
  );

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
    const firstAttack = "\x1b]52;c;T08_PENDING_FIRST\x07";
    const secondAttack = "\u009d0;T08_PENDING_SECOND\u009c";

    chatLog.addPendingSystem("run-1", `first ${firstAttack}notice`);
    chatLog.addPendingSystem("run-1", secondAttack);

    const raw = chatLog.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).not.toContain("first notice");
    expect(rendered).toContain("(no output)");
    expect(raw).not.toContain(firstAttack);
    expect(raw).not.toContain(secondAttack);
    expect(chatLog.children.length).toBe(1);
  });
});
