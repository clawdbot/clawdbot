// Feishu tests cover reply presentation resolution behavior.
import { describe, expect, it } from "vitest";
import { resolveFeishuReplyPresentation } from "./reply-presentation.js";

function cardJson(result: ReturnType<typeof resolveFeishuReplyPresentation>): string {
  expect(result?.kind, "resolved presentation kind").toBe("card");
  return JSON.stringify(result?.kind === "card" ? result.card : undefined);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("resolveFeishuReplyPresentation", () => {
  it("leaves a reply without controls untouched", () => {
    expect(resolveFeishuReplyPresentation({ text: "plain answer" })).toBeUndefined();
  });

  it("renders a presentation's buttons into a native card", () => {
    const result = resolveFeishuReplyPresentation({
      text: "Plugin bind approval required",
      presentation: {
        title: "Approve?",
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Allow once", action: { type: "command", command: "/approve once" } },
              { label: "Deny", action: { type: "command", command: "/approve deny" } },
            ],
          },
        ],
      },
    });

    const serialized = cardJson(result);
    expect(serialized).toContain("Allow once");
    expect(serialized).toContain("Deny");
    expect(serialized).toContain("Plugin bind approval required");
    expect(serialized).toContain("Approve?");
  });

  it("renders a legacy interactive reply's buttons into a native card", () => {
    const result = resolveFeishuReplyPresentation({
      text: "Plugin bind approval required",
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Allow once", value: "allow-once" },
              { label: "Deny", value: "deny" },
            ],
          },
        ],
      },
    });

    const serialized = cardJson(result);
    expect(serialized).toContain("Allow once");
    expect(serialized).toContain("allow-once");
    expect(serialized).toContain("Deny");
  });

  it("resolves a controls-only reply into a card", () => {
    const result = resolveFeishuReplyPresentation({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Approve", action: { type: "command", command: "/approve" } }],
          },
        ],
      },
    });

    expect(cardJson(result)).toContain("Approve");
  });

  it("does not repeat fallback prose that already renders the same blocks", () => {
    const result = resolveFeishuReplyPresentation({
      text: "Restart the gateway?\n\n- Yes\n- No",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Restart the gateway?" },
          {
            type: "buttons",
            buttons: [
              { label: "Yes", action: { type: "command", command: "/yes" } },
              { label: "No", action: { type: "command", command: "/no" } },
            ],
          },
        ],
      },
    });

    const serialized = cardJson(result);
    expect(countOccurrences(serialized, "Restart the gateway?")).toBe(1);
    expect(countOccurrences(serialized, "Yes")).toBe(1);
    expect(countOccurrences(serialized, "No")).toBe(1);
  });

  it("keeps the authored text when every data block degrades and nothing is interactive", () => {
    const result = resolveFeishuReplyPresentation({
      text: "Status\nUptime: 3h",
      presentationTextMode: "fallback",
      presentation: {
        title: "Status",
        blocks: [
          {
            type: "table",
            caption: "Runtime",
            headers: ["Fact", "Value"],
            rows: [["Uptime", "3h"]],
          },
        ],
      },
    });

    expect(result).toEqual({ kind: "text", text: "Status\nUptime: 3h" });
  });

  it("falls back to prose when the rendered card exceeds the Feishu envelope", () => {
    // Feishu rejects a card above 200 elements, so the labels have to survive as text.
    const result = resolveFeishuReplyPresentation({
      text: "Pick a run",
      presentation: {
        blocks: [
          ...Array.from({ length: 250 }, (_entry, index) => ({
            type: "text" as const,
            text: `line ${index}`,
          })),
          {
            type: "buttons" as const,
            buttons: [
              { label: "Open run", action: { type: "command" as const, command: "/open" } },
            ],
          },
        ],
      },
    });

    expect(result?.kind).toBe("text");
    const text = result?.kind === "text" ? result.text : "";
    expect(text).toContain("Pick a run");
    expect(text).toContain("Open run");
  });
});
