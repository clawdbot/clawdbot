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
  it("uses one avatar placement and keeps shared-thread authors readable", async () => {
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
    await expect(page.locator(".sidebar-identity-card openclaw-viewer-avatar")).toContainText("R");

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

    // Own-message footer: the always-visible name must stay put when hover
    // reveals the timestamp, which slots in to its left (right-aligned row).
    const ownGroup = userGroups.first();
    const ownName = ownGroup.locator(".chat-sender-name");
    await page.mouse.move(0, 0);
    await expect(ownGroup.locator(".chat-group-timestamp")).toHaveCSS("opacity", "0");
    const restingNameBox = await ownName.boundingBox();
    await ownGroup.hover();
    const ownTimestamp = ownGroup.locator(".chat-group-timestamp");
    await expect(ownTimestamp).toHaveCSS("opacity", "1");
    await captureProof(page, "own-group-hover.png");
    const hoveredNameBox = await ownName.boundingBox();
    const timestampBox = await ownTimestamp.boundingBox();
    expect(hoveredNameBox?.x).toBe(restingNameBox?.x);
    expect((timestampBox?.x ?? 0) + (timestampBox?.width ?? 0)).toBeLessThan(
      hoveredNameBox?.x ?? 0,
    );

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
    expect(footerOrder).toEqual(["Reply to message", "Rewind", "name", "time"]);

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
      await userGroup.getByRole("button", { name: "Reply to message" }).click();
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
