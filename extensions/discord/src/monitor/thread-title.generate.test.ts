// Discord tests cover thread title.generate plugin behavior.
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", { spy: true });

const generateConversationLabelMock = vi.fn<typeof generateConversationLabel>();
let generateThreadTitle: typeof import("./thread-title.js").generateThreadTitle;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

beforeAll(async () => {
  ({ generateThreadTitle } = await import("./thread-title.js"));
});

beforeEach(() => {
  vi.restoreAllMocks();
  generateConversationLabelMock.mockReset();
  generateConversationLabelMock.mockResolvedValue("Generated title");
  vi.mocked(generateConversationLabel).mockImplementation((...args) =>
    generateConversationLabelMock(...args),
  );
});

describe("generateThreadTitle", () => {
  it.each([
    [' "Weekly Release Summary"\nExtra text', "Weekly Release Summary"],
    ["```markdown\nWeekly Release Summary\n```", "Weekly Release Summary"],
    ["**Scaling ArcherScore Development Roadmap**", "Scaling ArcherScore Development Roadmap"],
    ['"__Weekly Release Summary__"', "Weekly Release Summary"],
    ["*Plan* for *project*", "*Plan* for *project*"],
    ["***Release plan***", "Release plan"],
  ])("normalizes generated title %j", async (generated, expected) => {
    generateConversationLabelMock.mockResolvedValueOnce(generated);
    await expect(
      generateThreadTitle({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        agentId: "main",
        messageText: "Need a generated title.",
      }),
    ).resolves.toBe(expected);
  });

  it("routes through the shared isolated label generator", async () => {
    await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      modelRef: "openai/gpt-4.1-mini@local",
      messageText: "Summarize deployment blockers and owner follow-ups.",
      channelName: "release-status",
      channelDescription: "Deploy updates and incident notes",
    });

    expect(generateConversationLabelMock).toHaveBeenCalledWith({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      userMessage:
        "Channel: release-status\n\nChannel description: Deploy updates and incident notes\n\nMessage:\nSummarize deployment blockers and owner follow-ups.",
      prompt:
        "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
      modelRef: "openai/gpt-4.1-mini@local",
      timeoutMs: 60_000,
      maxLength: 600,
    });
  });

  it("keeps truncated prompt fields on UTF-16 boundaries", async () => {
    await generateThreadTitle({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      messageText: `${"m".repeat(599)}😀tail`,
      channelName: `${"n".repeat(119)}😀tail`,
      channelDescription: `${"d".repeat(319)}😀tail`,
    });

    const content = generateConversationLabelMock.mock.calls[0]?.[0]?.userMessage ?? "";
    expect(hasLoneSurrogate(content)).toBe(false);
    expect(content).toContain(`${"m".repeat(599)}...`);
    expect(content).toContain(`${"n".repeat(119)}...`);
    expect(content).toContain(`${"d".repeat(319)}...`);
  });

  it("returns null for empty input, empty output, or generation failure", async () => {
    await expect(
      generateThreadTitle({ cfg: EMPTY_DISCORD_TEST_CONFIG, agentId: "main", messageText: " " }),
    ).resolves.toBeNull();
    generateConversationLabelMock.mockResolvedValueOnce(null);
    await expect(
      generateThreadTitle({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        agentId: "main",
        messageText: "Generate title.",
      }),
    ).resolves.toBeNull();
    generateConversationLabelMock.mockRejectedValueOnce(new Error("network timeout"));
    await expect(
      generateThreadTitle({
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        agentId: "main",
        messageText: "Generate title.",
      }),
    ).resolves.toBeNull();
  });
});
