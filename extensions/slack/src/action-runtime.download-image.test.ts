import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getImageMetadata } from "openclaw/plugin-sdk/media-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { slackActionRuntime } from "./action-runtime.js";
import { createSlackActions } from "./channel-actions.js";

const handleAction = createSlackActions("slack").handleAction;
if (!handleAction) {
  throw new Error("Slack channel action handler is missing");
}

describe("Slack downloaded image results", () => {
  let directory: string;
  let imagePath: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "slack-image-result-"));
    imagePath = path.join(directory, "wide.png");
    await writeFile(imagePath, createSolidPngBuffer(2600, 1300, { r: 40, g: 80, b: 120 }));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { configured: 600, expected: 600 },
    { configured: 2000, expected: 2000 },
    { configured: undefined, expected: 1200 },
  ])(
    "returns a $expected px image for configured limit $configured",
    async ({ configured, expected }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { imageMaxDimensionPx: configured } },
        channels: { slack: { botToken: "test-token", channels: { C123: { enabled: true } } } },
      };
      vi.spyOn(slackActionRuntime, "resolveSlackConversationInfo").mockResolvedValue({
        type: "channel",
      });
      vi.spyOn(slackActionRuntime, "downloadSlackFile").mockResolvedValue({
        path: imagePath,
        contentType: "image/png",
        placeholder: "synthetic Slack image",
      });

      const result = await handleAction({
        action: "download-file",
        channel: "slack",
        accountId: "default",
        cfg,
        params: { fileId: "F123", channelId: "C123" },
      });
      const image = result.content.find((block) => block.type === "image");
      if (!image || image.type !== "image") {
        throw new Error("Slack download did not return an image");
      }
      const bytes = Buffer.from(image.data, "base64");
      expect(await getImageMetadata(bytes)).toEqual({ width: expected, height: expected / 2 });
      expect(bytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(result.details).toMatchObject({
        fileId: "F123",
        path: imagePath,
        media: { outbound: false },
      });
    },
    20_000,
  );
});
