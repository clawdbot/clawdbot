// Control UI tests cover the settings profile page against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "profile-identity");

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.locator("#settings-profile-identity").screenshot({
    animations: "disabled",
    path: path.join(proofDir, name),
  });
}

let browser: Browser;
let server: ControlUiE2eServer;

const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  hasAvatar: false,
};
const testPresenceUsers = [
  {
    self: true,
    id: testProfile.id,
    name: testProfile.displayName,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${testProfile.updatedAt}`,
  },
];

describeControlUiE2e("Control UI profile page mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function openProfilePage(page: Page) {
    const gateway = await installMockGateway(page, {
      presenceUsers: testPresenceUsers,
      methodResponses: {
        "users.self": { profile: testProfile },
      },
    });
    const response = await page.goto(`${server.baseUrl}settings/profile`);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  it("renders hero, identity, and a Usage statistics link without loading usage", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const gateway = await openProfilePage(page);

      await page.locator(".profile-hero__name").waitFor({ timeout: 10_000 });
      await expect(page.locator(".profile-hero__name").textContent()).resolves.toContain(
        "OpenClaw",
      );
      await expect(page.locator(".profile-hero__handle").textContent()).resolves.toContain("@main");
      await page.locator(".profile-hero__avatar-mascot svg").waitFor({ timeout: 5_000 });
      await page.locator("#settings-profile-identity").waitFor({ timeout: 5_000 });
      await expect(
        page.getByRole("button", { name: /Usage statistics/u }).textContent(),
      ).resolves.toContain("View activity, costs, and usage trends.");
      expect(await gateway.getRequests("usage.cost")).toEqual([]);
      expect(await gateway.getRequests("sessions.usage")).toEqual([]);
      expect(await page.locator(".profile-stats, .profile-heatmap, .profile-tools").count()).toBe(
        0,
      );
    } finally {
      await context.close();
    }
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await browser.newContext({
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
        : {}),
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.route(`${server.baseUrl}settings/profile`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        body,
        headers: {
          ...response.headers(),
          "content-security-policy": buildControlUiCspHeader({
            inlineScriptHashes: computeInlineScriptHashes(body),
          }),
        },
        response,
      });
    });
    const gatewayUrl = server.baseUrl.replace(/^http/u, "ws").replace(/\/$/u, "");
    await page.addInitScript((sameOriginGatewayUrl) => {
      (
        window as Window & {
          ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
        gatewayUrl: sameOriginGatewayUrl,
        token: "test",
      };
    }, gatewayUrl);
    const avatarRequests: Array<{ authorization?: string; url: string }> = [];
    let releaseRevisedAvatar: (() => void) | undefined;
    const revisedAvatarReady = new Promise<void>((resolve) => {
      releaseRevisedAvatar = resolve;
    });
    // Profile images require the same bearer auth as gateway RPCs. One cached
    // blob keeps the sidebar and preview inside the Control UI's image CSP.
    await page.route(`**/api/users/${testProfile.id}/avatar*`, async (route) => {
      const revision = new URL(route.request().url()).searchParams.get("v");
      avatarRequests.push({
        authorization: route.request().headers().authorization,
        url: route.request().url(),
      });
      if (revision === "3") {
        // Hold the real response so Chromium can prove pending fallback and
        // stable image-node identity before the replacement finishes loading.
        await revisedAvatarReady;
      }
      if (revision === "4") {
        await route.fulfill({
          body: JSON.stringify({ ok: false, error: { type: "not_found" } }),
          contentType: "application/json",
          status: 404,
        });
        return;
      }
      await route.fulfill({
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=",
          "base64",
        ),
        contentType: "image/png",
        status: 200,
      });
    });
    const gateway = await installMockGateway(page, {
      presenceUsers: testPresenceUsers,
      methodResponses: {
        "users.self": { profile: testProfile },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(
        "img-src 'self' data: blob:",
      );

      const profileAvatar = page.locator("#settings-profile-identity openclaw-viewer-avatar img");
      await profileAvatar.waitFor({ timeout: 10_000 });
      const imageUrl = await profileAvatar.getAttribute("src");
      expect(imageUrl).toMatch(/^blob:/u);
      await expect
        .poll(() => profileAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1);
      expect(
        await profileAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "03-authenticated-profile-avatar.png"),
        });
      }

      await page.getByRole("button", { name: "Back to app" }).click();
      const sidebarAvatar = page.locator(".sidebar-identity-card openclaw-viewer-avatar img");
      await sidebarAvatar.waitFor({ timeout: 10_000 });
      await expect.poll(() => avatarRequests.length).toBe(1);
      expect(avatarRequests[0]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: expect.stringContaining(`/api/users/${testProfile.id}/avatar?v=2`),
      });
      expect(await sidebarAvatar.getAttribute("src")).toBe(imageUrl);
      expect(
        await sidebarAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "03-authenticated-user-avatar-cache.png"),
        });
      }

      const originalSidebarImage = await sidebarAvatar.elementHandle();
      expect(originalSidebarImage).not.toBeNull();
      const connect = await gateway.waitForRequest("connect");
      const selfInstanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(selfInstanceId).toBeTruthy();
      const publishAvatarRevision = async (revision: number) => {
        await gateway.emitGatewayEvent("presence", {
          presence: [
            {
              instanceId: selfInstanceId,
              mode: "webchat",
              reason: "connect",
              user: {
                id: testProfile.id,
                name: testProfile.displayName,
                email: testProfile.emails[0],
                avatarUrl: `/api/users/${testProfile.id}/avatar?v=${revision}`,
              },
              watchedSessions: [],
            },
          ],
        });
      };

      await publishAvatarRevision(3);
      await expect.poll(() => avatarRequests.length).toBe(2);
      expect(
        await originalSidebarImage?.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(true);
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);

      releaseRevisedAvatar?.();
      await expect
        .poll(() => sidebarAvatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBe(1);
      const revisedImageUrl = await sidebarAvatar.getAttribute("src");
      expect(revisedImageUrl).toMatch(/^blob:/u);
      expect(revisedImageUrl).not.toBe(imageUrl);
      expect(await originalSidebarImage?.evaluate((image) => image.getAttribute("src"))).toBe(
        revisedImageUrl,
      );
      expect(
        await sidebarAvatar.evaluate((image) =>
          image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
        ),
      ).toBe(false);
      expect(avatarRequests[1]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: expect.stringContaining(`/api/users/${testProfile.id}/avatar?v=3`),
      });
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "04-authenticated-user-avatar-revision.png"),
        });
      }

      const missingAvatarResponse = page.waitForResponse(
        (candidateResponse) =>
          candidateResponse.url().includes(`/api/users/${testProfile.id}/avatar?v=4`) &&
          candidateResponse.status() === 404,
      );
      await publishAvatarRevision(4);
      await missingAvatarResponse;
      await expect.poll(() => avatarRequests.length).toBe(3);
      await expect.poll(() => sidebarAvatar.getAttribute("src")).toBeNull();
      await expect
        .poll(() =>
          sidebarAvatar.evaluate((image) =>
            image.closest(".viewer-avatar")?.classList.contains("is-fallback"),
          ),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          (
            await page.locator(".sidebar-identity-card .viewer-avatar__fallback").textContent()
          )?.trim(),
        )
        .toBe("TP");
      expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);
      expect(avatarRequests[2]).toEqual({
        authorization: "Bearer e2e-device-token",
        url: expect.stringContaining(`/api/users/${testProfile.id}/avatar?v=4`),
      });
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "05-authenticated-user-avatar-missing.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("retries the missing identity bootstrap and opens the profile editor", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      presenceUsers: testPresenceUsers,
      methodResponses: {
        "users.self": { sequence: [{}, { profile: testProfile }] },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);

      const emptyState = page.locator(".profile-identity-empty");
      await emptyState.waitFor({ timeout: 10_000 });
      await expect(emptyState.textContent()).resolves.toContain("Identity is not set.");
      await screenshot(page, "01-identity-not-set.png");

      await page.getByRole("button", { name: "Set identity" }).click();

      await page.locator('.identity-name-control input[type="text"]').waitFor({ timeout: 10_000 });
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);
      await expect(page.locator(".identity-name-control input").inputValue()).resolves.toBe(
        testProfile.displayName,
      );
      await screenshot(page, "02-identity-editor.png");
    } finally {
      await context.close();
    }
  });
});
