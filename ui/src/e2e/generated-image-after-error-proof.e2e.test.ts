import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { mergeAttemptToolMediaPayloads } from "../../../src/agents/embedded-agent-runner/run/tool-media-payloads.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a generated image visible after an error reply", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const imageData = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
    const imageUrl = `data:image/png;base64,${imageData.toString("base64")}`;
    const payloads =
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "Image generation tool failed before retry.", isError: true }],
        toolMediaUrls: [imageUrl],
      }) ?? [];

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ isError: true });
    expect(payloads[1]).toMatchObject({ mediaUrl: imageUrl });

    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: payloads[0]?.text }],
          isError: true,
          timestamp: Date.now() - 1,
        },
        {
          role: "assistant",
          content: [{ type: "image", url: payloads[1]?.mediaUrl, alt: "Generated image preview" }],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Image generation tool failed before retry.").waitFor();
      const image = page.getByAltText("Generated image preview");
      await image.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(180);

      const artifactDir = path.join(
        process.cwd(),
        ".artifacts",
        "qa-e2e",
        "pr-131226-webchat-proof",
      );
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "error-and-generated-image.png"),
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
