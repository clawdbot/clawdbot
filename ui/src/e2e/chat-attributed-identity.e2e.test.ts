// Control UI E2E tests cover attributed chat identity placement.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type Browser, type Page } from "playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
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

function resolveArtifactDir(): string | undefined {
  return process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim() || undefined;
}

async function captureProof(page: Page, name: string) {
  const artifactDir = resolveArtifactDir();
  if (!artifactDir) {
    return;
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifactDir, name),
  });
}

describeControlUiE2e("Control UI attributed chat identity", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("uses one avatar placement and keeps shared-thread authors readable", async () => {
    const artifactDir = resolveArtifactDir();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      viewport: { height: 760, width: 1180 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 760, width: 1180 } } }
        : {}),
    });
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      presenceUsers: [
        { self: true, id: "profile-riley", name: "Riley", email: "riley@example.test" },
        { id: "profile-colin", name: "Colin", email: "colin@example.test" },
      ],
      historyMessages: [
        {
          role: "assistant",
          content: "The shared thread now keeps every participant easy to identify.",
          timestamp: now - 180_000,
        },
        {
          role: "user",
          content: "Can we keep one clear avatar and show who wrote each message?",
          timestamp: now - 120_000,
          __openclaw: {
            id: "riley-message",
            senderId: "profile-riley",
            senderName: "Riley",
            seq: 2,
          },
        },
        {
          role: "assistant",
          content: "Yes — one author marker is enough, with the name kept readable.",
          timestamp: now - 90_000,
        },
        {
          role: "user",
          content: "This is much easier to scan in a team conversation.",
          timestamp: now - 30_000,
          __openclaw: {
            id: "colin-message",
            senderId: "profile-colin",
            senderName: "Colin",
            seq: 4,
          },
        },
      ],
    });

    await page.goto(`${server.baseUrl}chat?session=agent%3Amain%3Amain`);
    await page.getByText("This is much easier to scan in a team conversation.").waitFor();

    const userGroups = page.locator(".chat-group.user");
    await expect(userGroups).toHaveCount(2);
    await expect(page.locator(".chat-avatar.user")).toHaveCount(2);

    await expect(
      page.locator(".chat-group-footer--persistent-identity .chat-sender-name"),
    ).toHaveText(["Riley", "Colin"]);
    await expect(page.locator(".chat-author-avatar")).toHaveCount(0);
    const hoverDetails = userGroups.last().locator(".chat-group-timestamp");
    await expect(hoverDetails).toHaveCSS("opacity", "0");
    await captureProof(page, "after-default.png");

    await userGroups.last().hover();
    await expect(hoverDetails).toHaveCSS("opacity", "1");
    await expect(page.locator(".chat-author-avatar")).toHaveCount(0);
    await captureProof(page, "after-hover.png");

    const footerOrder = await userGroups
      .last()
      .locator(".chat-group-footer")
      .locator("button, .chat-sender-name, .chat-group-timestamp")
      .evaluateAll((elements) =>
        elements.map((element) => {
          if (element.classList.contains("chat-sender-name")) {
            return "name";
          }
          if (element.classList.contains("chat-group-timestamp")) {
            return "time";
          }
          return element.getAttribute("aria-label");
        }),
      );
    expect(footerOrder).toEqual(["Reply to message", "Hide message", "Rewind", "name", "time"]);

    await context.close();
  });
});
