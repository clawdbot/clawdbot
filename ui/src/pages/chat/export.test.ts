import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatMarkdown, exportChatMarkdown } from "./export.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportChatMarkdown", () => {
  it("reports an empty transcript without creating a download", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    expect(exportChatMarkdown([], "OpenClaw")).toBe("empty");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads one readable Markdown file for a populated transcript", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chat-export");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(
      exportChatMarkdown(
        [
          { role: "user", content: "What can you export?", timestamp: 1_000 },
          { role: "assistant", content: "A readable conversation.", timestamp: 2_000 },
        ],
        "OpenClaw",
      ),
    ).toBe("downloaded");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:chat-export");
    expect((createObjectURL.mock.calls[0]![0] as Blob).type).toBe("text/markdown");
    const markdown = await (createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(markdown).toContain("# Chat with OpenClaw");
    expect(markdown).toContain("## You");
    expect(markdown).toContain("What can you export?");
    expect(markdown).toContain("## OpenClaw");
    expect(markdown).toContain("A readable conversation.");
  });

  it("uses transcript speaker normalization without inventing timestamps or exporting silent replies", () => {
    const markdown = buildChatMarkdown(
      [
        {
          role: "USER",
          senderLabel: "Kai (123e4567-e89b-12d3-a456-426614174000)",
          content: "Please check the build.",
        },
        {
          role: "ASSISTANT",
          __openclaw: { senderName: "Build assistant" },
          content: [{ type: "output_text", text: "The build passed." }],
          timestamp: 1_000,
        },
        { role: "tool_result", content: "exit 0" },
        { role: "assistant", content: "NO_REPLY" },
      ],
      "OpenClaw",
    );

    expect(markdown).toBe(
      "# Chat with OpenClaw\n\n" +
        "## Kai\n\nPlease check the build.\n\n" +
        "## Build assistant (1970-01-01T00:00:01.000Z)\n\nThe build passed.\n\n" +
        "## Tool\n\nexit 0\n",
    );
  });
});
