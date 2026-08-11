// Control UI E2E tests cover attributed chat identity placement.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI attributed chat identity",
  startServerBeforeBrowser: true,
});

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

suite.define(() => {
  it("keeps every shared-thread author visible in the document flow", async () => {
    const artifactDir = resolveArtifactDir();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 760, width: 1180 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 760, width: 1180 } } }
        : {}),
    });
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.rewind"],
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
    await page.getByText("This is much easier to scan in a team conversation.").waitFor();

    const userGroups = page.locator(".chat-group.user");
    await expect(userGroups).toHaveCount(2);
    await expect(page.locator(".chat-avatar.user")).toHaveCount(2);
    await expect(page.locator(".chat-avatar.user")).toHaveText(["R", "C"]);
    await expect(page.locator(".chat-avatar.assistant")).toHaveCount(2);
    await expect(page.locator(".sidebar-identity-card openclaw-viewer-avatar")).toContainText("R");

    await expect(page.locator(".chat-group-footer .chat-sender-name")).toHaveText([
      "OpenClaw",
      "Riley",
      "OpenClaw",
      "Colin",
    ]);
    await expect(page.locator(".chat-author-avatar")).toHaveCount(0);
    const timestamps = page.locator(".chat-group:is(.user, .assistant) .chat-group-timestamp");
    await expect(timestamps).toHaveCount(4);
    for (let index = 0; index < (await timestamps.count()); index += 1) {
      await expect(timestamps.nth(index)).toHaveCSS("opacity", "1");
    }
    await captureProof(page, "after-default.png");

    await context.close();
  });

  it("keeps missing local-viewer avatar initials through a live rerender", async () => {
    const artifactDir = resolveArtifactDir();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 760, width: 1180 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 760, width: 1180 } } }
        : {}),
    });
    const page = await context.newPage();
    const viewer = {
      id: "dd7c98e2-f51d-4590-b588-fa0682e165b7",
      name: "Hannah",
      avatarUrl: "/api/users/dd7c98e2-f51d-4590-b588-fa0682e165b7/avatar?v=7",
    };
    let avatarRequestCount = 0;
    const avatarRequests: Array<{ resourceType: string; url: string }> = [];
    let releaseRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let markRetryStarted: () => void = () => undefined;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    let markRetrySettled: () => void = () => undefined;
    const retrySettled = new Promise<void>((resolve) => {
      markRetrySettled = resolve;
    });
    await page.route(`**/api/users/${viewer.id}/avatar*`, async (route) => {
      avatarRequests.push({
        resourceType: route.request().resourceType(),
        url: route.request().url(),
      });
      const requestIndex = ++avatarRequestCount;
      if (requestIndex === 2) {
        markRetryStarted();
        await retryGate;
      }
      await route.fulfill({
        body: JSON.stringify({ ok: false, error: { type: "not_found" } }),
        contentType: "application/json",
        status: 404,
      });
      if (requestIndex === 2) {
        markRetrySettled();
      }
    });
    await installMockGateway(page, {
      presenceUsers: [
        {
          self: true,
          ...viewer,
          email: "hannah@example.test",
          watchedSessions: ["agent:main:main"],
        },
      ],
      historyMessages: [
        {
          role: "user",
          content: "Please keep my fallback avatar readable.",
          timestamp: Date.now() - 60_000,
        },
      ],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.getByText("Please keep my fallback avatar readable.").waitFor();

      const userGroup = page.locator(".chat-group.user", {
        hasText: "Please keep my fallback avatar readable.",
      });
      const slot = userGroup.locator(".chat-avatar-slot");
      const image = slot.locator("img.chat-avatar.user");
      const initials = slot.locator(".chat-avatar--sender-initials");
      await retryStarted;
      expect(avatarRequestCount).toBe(2);
      expect(
        avatarRequests.map((request) => ({
          resourceType: request.resourceType,
          url: new URL(request.url).pathname + new URL(request.url).search,
        })),
      ).toEqual([
        { resourceType: "fetch", url: viewer.avatarUrl },
        { resourceType: "fetch", url: viewer.avatarUrl },
      ]);
      await expect(slot).toHaveClass(/\bis-fallback\b/u);
      await expect(slot.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
      await captureProof(page, "missing-local-avatar-after-404.png");

      await userGroup.hover();
      const replyButton = userGroup.locator("button.chat-reply-btn");
      expect(await replyButton.count()).toBe(1);
      expect(await replyButton.isVisible()).toBe(true);
      await replyButton.click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      await expect(replyPreview.locator(".chat-reply-preview__text")).toHaveText(
        "Please keep my fallback avatar readable.",
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(avatarRequestCount).toBe(2);
      await expect(slot).toHaveClass(/\bis-fallback\b/u);
      await expect(slot.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
      await captureProof(page, "missing-local-avatar-after-rerender.png");

      releaseRetry();
      await retrySettled;
      await expect.poll(() => image.getAttribute("src")).toBeNull();
      await expect(slot).toHaveClass(/\bis-fallback\b/u);
      await expect(initials).toBeVisible();
    } finally {
      releaseRetry();
      await context.close();
    }
  });
});
