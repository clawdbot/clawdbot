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

  it("restores adopted historical users in their subsequent live-event order", () => {
    const chatLog = new ChatLog(40);

    chatLog.addUser("Historical first prompt.", {
      messageId: "historical-first",
      messageSeq: 1,
    });
    chatLog.addUser("Historical second prompt.", {
      messageId: "historical-second",
      messageSeq: 2,
    });
    chatLog.addLiveUser("Second prompt updated first.", {
      messageId: "historical-second",
      messageSeq: 3,
    });
    chatLog.addLiveUser("First prompt updated second.", {
      messageId: "historical-first",
      messageSeq: 4,
    });

    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.restoreLiveUsers();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(2);
    expect(rendered.indexOf("Second prompt updated first.")).toBeLessThan(
      rendered.indexOf("First prompt updated second."),
    );
  });

  it("keeps the latest known live sequence when history adopts a prompt without one", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Original live prompt.", {
      messageId: "shared-user",
      messageSeq: 3,
    });
    chatLog.addUser("Persisted shared prompt.", { messageId: "shared-user" });
    chatLog.addLiveUser("Updated shared prompt.", { messageId: "shared-user" });

    chatLog.clearAll({ preserveLiveUsers: true });
    chatLog.restoreLiveUsers(3);
    expect(chatLog.children).toHaveLength(0);

    chatLog.restoreLiveUsers(4);
    expect(chatLog.children).toHaveLength(1);
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Updated shared prompt.");
  });
});
