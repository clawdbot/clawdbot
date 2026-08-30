import { afterEach, describe, expect, it, vi } from "vitest";
import { exportChatMarkdown } from "./export.ts";

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
    const markdown = await (createObjectURL.mock.calls[0]![0] as Blob).text();
    expect(markdown).toContain("# Chat with OpenClaw");
    expect(markdown).toContain("## You");
    expect(markdown).toContain("What can you export?");
    expect(markdown).toContain("## OpenClaw");
    expect(markdown).toContain("A readable conversation.");
  });
});
