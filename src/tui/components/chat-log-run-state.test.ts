// Covers canonical assistant-run ownership and live transcript identity.
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";

describe("ChatLog run state", () => {
  it("keeps revised snapshots scoped to their own concurrent assistant run", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Obsolete first reply.", "run-first");
    chatLog.updateAssistant("Preserved second reply.", "run-second");
    chatLog.startTool("first-tool", "read_file", { path: "first.txt" }, "run-first");
    chatLog.updateAssistant("Revised first reply.", "run-first");
    chatLog.updateAssistant("Preserved second reply.\n\nSecond continuation.", "run-second");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Obsolete first reply.");
    expect(rendered.split("Revised first reply.")).toHaveLength(2);
    expect(rendered.split("Preserved second reply.")).toHaveLength(2);
    expect(rendered.split("Second continuation.")).toHaveLength(2);
    expect(rendered.indexOf("Preserved second reply.")).toBeLessThan(
      rendered.indexOf("Second continuation."),
    );
  });

  it("infers tool ownership from the only streaming run after another run finalizes", () => {
    const chatLog = new ChatLog(40);

    chatLog.finalizeAssistant("Completed first reply.", "run-first");
    chatLog.updateAssistant("Streaming second reply.", "run-second");
    chatLog.startTool("second-tool", "read_file", { path: "second.txt" });
    chatLog.addLiveUser("Delayed second prompt.", {
      messageId: "second-user",
      runId: "run-second",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.indexOf("Completed first reply.")).toBeLessThan(
      rendered.indexOf("Delayed second prompt."),
    );
    expect(rendered.indexOf("Delayed second prompt.")).toBeLessThan(
      rendered.indexOf("Streaming second reply."),
    );
    expect(rendered.indexOf("Streaming second reply.")).toBeLessThan(rendered.indexOf("Read File"));
  });

  it("keeps a replacement final reply anchored when its previous reply is pruned", () => {
    const chatLog = new ChatLog(20);

    chatLog.finalizeAssistant("Previous completed reply.", "run-replaced");
    for (let index = 0; index < 19; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
    chatLog.finalizeAssistant("Replacement completed reply.", "run-replaced");
    chatLog.addLiveUser("Delayed replacement prompt.", {
      messageId: "replacement-user",
      runId: "run-replaced",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Previous completed reply.");
    expect(rendered.indexOf("Delayed replacement prompt.")).toBeLessThan(
      rendered.indexOf("Replacement completed reply."),
    );
  });

  it("infers active tool ownership after another finalized run leaves scrollback", () => {
    const chatLog = new ChatLog(20);

    chatLog.finalizeAssistant("Evicted completed reply.", "run-evicted");
    chatLog.updateAssistant("Surviving streamed reply.", "run-active");
    for (let index = 0; index < 18; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
    chatLog.startTool("active-tool", "read_file", { path: "active.txt" });
    chatLog.addLiveUser("Delayed active prompt.", {
      messageId: "active-user",
      runId: "run-active",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Evicted completed reply.");
    expect(rendered.indexOf("Delayed active prompt.")).toBeLessThan(
      rendered.indexOf("Surviving streamed reply."),
    );
    expect(rendered.indexOf("Surviving streamed reply.")).toBeLessThan(
      rendered.indexOf("Read File"),
    );
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

    chatLog.addPendingUser("local", "queued hello");
    chatLog.startAssistant("hi there", "r-accepted");

    expect(chatLog.rekeyPendingUser("local", "r-accepted")).toBe(true);

    const rendered = chatLog.render(120).join("\n");
    expect(rendered.indexOf("queued hello")).toBeLessThan(rendered.indexOf("hi there"));
    // The row is now addressable by the gateway-assigned runId.
    expect(chatLog.dropPendingUser("r-accepted")).toBe(true);
    expect(chatLog.countPendingUsers()).toBe(0);
  });
});
