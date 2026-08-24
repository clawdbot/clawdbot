import { describe, expect, it, vi } from "vitest";
import { createProgressCardTool } from "./progress-card-tool.js";

const DESCRIPTION =
  'Maintain this session\'s progress card: the single durable status surface shown next to the session in OpenClaw\'s UIs, for someone who is not reading the transcript. Keep it current on any task that takes more than a moment — it is how the user watches you work without scrolling. Each call replaces the whole card. Pick the representation that fits the work, using either or both parts: `markdown` — a compact note; tables for comparisons or metrics, <progress value="3" max="7"></progress> bars for one long operation, a bold one-liner for simple state; other raw HTML is stripped. Known URL? Link it. Don’t leave PRs or issues as bare IDs. And `plan` — an ordered step checklist (pending | in_progress | completed, at most one in_progress) for genuinely sequential work. The checklist is optional: omit it whenever a table, bar, or sentence says it better, and never repeat the same facts in both parts. Call with both parts empty to clear. Update on meaningful change — a step done, a blocker, results in — not every message. Max 8 KB markdown, 50 steps.';

describe("progress_card tool", () => {
  it("replaces the card and returns compact progress receipts", async () => {
    const steps = [
      { step: "Inspect", status: "completed" as const },
      { step: "Patch", status: "in_progress" as const },
      { step: "Verify", status: "pending" as const },
    ];
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        card: {
          sessionKey: "agent:main:main",
          markdown: "Implementation underway",
          steps,
          revision: 3,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        card: {
          sessionKey: "agent:main:main",
          markdown: "A note",
          revision: 4,
          updatedAt: 2,
        },
      })
      .mockResolvedValueOnce({ card: null });
    const tool = createProgressCardTool({
      agentSessionKey: "agent:main:main",
      callGateway,
    });

    expect(tool.description).toBe(DESCRIPTION);
    expect(tool.requiredClientCaps).toBeUndefined();
    const planned = await tool.execute("call-1", {
      markdown: "Implementation underway",
      plan: steps,
    });
    expect(callGateway).toHaveBeenNthCalledWith(1, "progressCard.put", {
      sessionKey: "agent:main:main",
      markdown: "Implementation underway",
      plan: steps,
    });
    expect(planned.details).toEqual({ revision: 3, steps: { completed: 1, total: 3 } });
    expect(planned.content[0]).toEqual({
      type: "text",
      text: "Progress card updated (rev 3, 1/3 done)",
    });

    const note = await tool.execute("call-2", { markdown: "A note" });
    expect(note.details).toEqual({ revision: 4, steps: null });
    expect(note.content[0]).toEqual({ type: "text", text: "Progress card updated (rev 4)" });

    const cleared = await tool.execute("call-3", {});
    expect(callGateway).toHaveBeenNthCalledWith(3, "progressCard.put", {
      sessionKey: "agent:main:main",
    });
    expect(cleared.details).toEqual({ revision: null, steps: null });
    expect(cleared.content[0]).toEqual({ type: "text", text: "Progress card cleared" });
  });

  it.each([
    {
      name: "multiple active steps",
      args: {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      },
      message: "at most one in_progress",
    },
    {
      name: "too many steps",
      args: {
        plan: Array.from({ length: 51 }, (_, index) => ({
          step: `Step ${index}`,
          status: "pending",
        })),
      },
      message: "at most 50 steps",
    },
    {
      name: "empty step",
      args: { plan: [{ step: " \u200b ", status: "pending" }] },
      message: "must not be empty",
    },
    {
      name: "oversized step",
      args: { plan: [{ step: "é".repeat(257), status: "pending" }] },
      message: "512 UTF-8 bytes",
    },
    {
      name: "oversized markdown",
      args: { markdown: "é".repeat(4097) },
      message: "8192 UTF-8 bytes",
    },
  ])("rejects $name before writing", async ({ args, message }) => {
    const callGateway = vi.fn();
    const tool = createProgressCardTool({ agentSessionKey: "agent:main:main", callGateway });

    await expect(tool.execute("call-invalid", args)).rejects.toThrow(message);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails before calling the gateway without a session", async () => {
    const callGateway = vi.fn();
    const tool = createProgressCardTool({ callGateway });

    await expect(tool.execute("call-1", { markdown: "Working" })).rejects.toMatchObject({
      name: "ToolInputError",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
