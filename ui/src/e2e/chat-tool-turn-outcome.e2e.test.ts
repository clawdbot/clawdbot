// Control UI E2E tests cover autonomous tool-turn outcome rendering.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function failedTool(timestamp: number) {
  return {
    role: "toolResult",
    toolName: "shell",
    content: JSON.stringify({ status: "failed", exitCode: 1 }),
    isError: true,
    timestamp,
  };
}

async function captureToolActivityProof(page: import("playwright").Page, name: string) {
  const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

describeControlUiE2e("Control UI autonomous tool-turn outcomes", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps an earlier autonomous failure visible after a later turn recovers", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        failedTool(1),
        {
          role: "assistant",
          content: [{ type: "text", text: "Start the next autonomous task." }],
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderLabel: "Forwarded from main",
          timestamp: 2,
        },
        failedTool(3),
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered on the next autonomous turn." }],
          timestamp: 4,
        },
      ],
    });

    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("Recovered on the next autonomous turn.", { exact: true }).waitFor();

    expect(await page.locator(".chat-tool-msg-summary__label").allTextContents()).toEqual([
      "Tool error",
      "Tool output",
    ]);
    // The earlier failure must stay visibly marked as an error even though a
    // later turn recovered; the recovered row must render neutral.
    const summaryClasses = await page
      .locator(".chat-tool-msg-summary")
      .evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(summaryClasses).toHaveLength(2);
    expect(summaryClasses[0]).toContain("chat-tool-msg-summary--error");
    expect(summaryClasses[1]).not.toContain("chat-tool-msg-summary--error");
    await context.close();
  });

  it("pairs a canonical parallel batch and renders per-file patch sections", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1200 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "/repo/src/a.ts", offset: 3, limit: 20 },
            },
            {
              type: "toolCall",
              id: "call-patch",
              name: "apply_patch",
              arguments: {
                input: [
                  "*** Begin Patch",
                  "*** Update File: src/a.ts",
                  "@@",
                  "-const before = true;",
                  "+const after = true;",
                  "*** Add File: src/b.ts",
                  "+export const created = true;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "A_ONLY_fixture" }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-patch",
          toolName: "apply_patch",
          content: [{ type: "text", text: "Applied patch" }],
          timestamp: 3,
        },
      ],
    });

    await page.goto(`${server.baseUrl}chat`);
    const activity = page.locator(".chat-activity-group__summary");
    await activity.waitFor();
    expect(await activity.textContent()).toContain("Read a file, edited 2 files");
    if ((await activity.getAttribute("aria-expanded")) !== "true") {
      await activity.click();
    }

    const rows = page.locator(".chat-activity-group__body .chat-tool-msg-summary");
    expect(await rows.count()).toBe(2);
    expect(await page.locator(".chat-tool-msg-summary__label", { hasText: "Tool" }).count()).toBe(
      0,
    );
    await rows.first().click();
    expect(await page.getByText("offset:", { exact: true }).count()).toBe(1);
    expect(await page.getByText("limit:", { exact: true }).count()).toBe(1);
    const patchRow = rows.filter({ hasText: "2 files" });
    await patchRow.click();

    expect(await page.locator(".chat-diff__row--file .chat-diff__text").allTextContents()).toEqual([
      "Update src/a.ts",
      "Add src/b.ts",
    ]);
    expect(await page.locator(".chat-diff__row--del .chat-diff__text").allTextContents()).toContain(
      "const before = true;",
    );
    expect(await page.locator(".chat-diff__row--add .chat-diff__text").allTextContents()).toEqual(
      expect.arrayContaining(["const after = true;", "export const created = true;"]),
    );
    const rawDetails = page.getByRole("button", { name: "Raw details" });
    await rawDetails.click();
    await page.getByText("Applied patch", { exact: true }).waitFor();
    await captureToolActivityProof(page, "parallel-multifile-expanded");
    await context.close();
  });
});
