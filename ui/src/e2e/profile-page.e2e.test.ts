// Control UI tests cover the settings profile page against a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "profile-identity");
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;

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

suite.define(() => {
  async function openProfilePage(page: Page, methodResponses: Record<string, unknown> = {}) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers: testPresenceUsers,
      methodResponses: {
        "users.self": { profile: testProfile },
        ...methodResponses,
      },
    });
    const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  it("renders hero, identity, and a Usage statistics link without loading usage", async () => {
    await suite.withPage(undefined, async ({ page }) => {
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
    });
  });

  it("renders the protected assistant avatar through an authenticated blob fetch", async () => {
    await suite.withPage(
      {
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
          : {}),
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        const avatarRequests: Array<{ authorization?: string; resourceType: string; url: string }> =
          [];
        const avatarUrl = new URL(`${basePath}/avatar/main`, suite.server.baseUrl).href;
        await page.route(`**${basePath}/avatar/main`, async (route) => {
          const authorization = route.request().headers().authorization;
          avatarRequests.push({
            authorization,
            resourceType: route.request().resourceType(),
            url: route.request().url(),
          });
          if (authorization !== "Bearer e2e-device-token") {
            await route.fulfill({ status: 401 });
            return;
          }
          await route.fulfill({
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#ef4e2f"/><circle cx="23" cy="27" r="4" fill="white"/><circle cx="41" cy="27" r="4" fill="white"/><path d="M20 42c8 6 16 6 24 0" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>`,
            contentType: "image/svg+xml",
            status: 200,
          });
        });
        const gateway = await openProfilePage(page, {
          "agent.identity.get": {
            agentId: "main",
            name: "Main agent",
            avatar: `${basePath}/avatar/main`,
            avatarStatus: "local",
          },
          "agents.list": {
            defaultId: "main",
            agents: [
              {
                id: "main",
                identity: { name: "Main agent", avatarUrl: `${basePath}/avatar/main` },
              },
            ],
          },
        });

        await gateway.waitForRequest("agent.identity.get");
        const image = page.locator(".profile-hero__avatar-image");
        await image.waitFor({ timeout: 10_000 });
        await expect.poll(() => image.getAttribute("src")).toMatch(/^blob:/u);
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
          .toBe(64);
        expect(avatarRequests.length).toBeGreaterThan(0);
        expect(new Set(avatarRequests.map((request) => JSON.stringify(request)))).toEqual(
          new Set([
            JSON.stringify({
              authorization: "Bearer e2e-device-token",
              resourceType: "fetch",
              url: avatarUrl,
            }),
          ]),
        );
        if (captureUiProof) {
          await mkdir(proofDir, { recursive: true });
          await page.locator(".profile-hero").screenshot({
            animations: "disabled",
            path: path.join(proofDir, "06-authenticated-assistant-avatar.png"),
          });
        }
      },
    );
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
    if (captureUiProof) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
          : {}),
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        await page.route(new URL(profilePath, suite.server.baseUrl).href, async (route) => {
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
        const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws").replace(/\/$/u, "");
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
          basePath,
          presenceUsers: testPresenceUsers,
          methodResponses: {
            "users.self": { profile: testProfile },
          },
        });

        const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
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
          url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=2`, suite.server.baseUrl)
            .href,
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
        const updatedDisplayName = "Updated Person";
        const publishAvatarRevision = async (revision: number) => {
          await gateway.emitGatewayEvent("presence", {
            presence: [
              {
                instanceId: selfInstanceId,
                mode: "webchat",
                reason: "connect",
                user: {
                  id: testProfile.id,
                  name: updatedDisplayName,
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
        await expect(page.locator(".sidebar-identity-card__name")).toHaveText(updatedDisplayName);
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
          url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=3`, suite.server.baseUrl)
            .href,
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
          .toBe("UP");
        expect(await originalSidebarImage?.evaluate((image) => image.isConnected)).toBe(true);
        expect(avatarRequests[2]).toEqual({
          authorization: "Bearer e2e-device-token",
          url: new URL(`${basePath}/api/users/${testProfile.id}/avatar?v=4`, suite.server.baseUrl)
            .href,
        });
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "05-authenticated-user-avatar-missing.png"),
          });
        }
      },
    );
  });

  it("retries the missing identity bootstrap and opens the profile editor", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        basePath,
        presenceUsers: testPresenceUsers,
        methodResponses: {
          "users.self": { sequence: [{}, { profile: testProfile }] },
        },
      });

      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
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
    });
  });

  it("keeps identity refresh single-flight and retries after a failed request", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        basePath,
        deferredMethods: ["users.self"],
        presenceUsers: testPresenceUsers,
        methodResponses: {
          "users.self": { profile: testProfile },
        },
      });

      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);

      const refresh = page.locator(".profile-refresh");
      await gateway.waitForRequest("users.self");
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(1);
      await expect.poll(() => refresh.isDisabled()).toBe(true);
      expect(await refresh.ariaSnapshot()).toContain('button "Refreshing…" [disabled]');

      await refresh.evaluate((element) => {
        const button = element as HTMLButtonElement;
        button.click();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(1);

      await gateway.rejectDeferred("users.self", { message: "identity unavailable" });
      await page.getByText("identity unavailable", { exact: true }).waitFor({ timeout: 10_000 });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(await refresh.ariaSnapshot()).toContain('button "Refresh"');

      await gateway.deferNext("users.self");
      await refresh.click();
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);
      await expect.poll(() => refresh.isDisabled()).toBe(true);
      expect(await refresh.ariaSnapshot()).toContain('button "Refreshing…" [disabled]');

      await refresh.evaluate((element) => {
        (element as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);

      await gateway.resolveDeferred("users.self", { profile: testProfile });
      const displayName = page.locator('.identity-name-control input[type="text"]');
      await displayName.waitFor({ timeout: 10_000 });
      await expect(displayName.inputValue()).resolves.toBe(testProfile.displayName);
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(await refresh.ariaSnapshot()).toContain('button "Refresh"');
    });
  });

  it("keeps event revisions through same-timestamp avatar responses", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const avatarRequests: string[] = [];
      await page.route(`**/api/users/${testProfile.id}/avatar*`, async (route) => {
        avatarRequests.push(route.request().url());
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
        basePath,
        deferredMethods: ["users.setAvatar"],
        presenceUsers: testPresenceUsers,
        methodResponses: {
          "users.self": { profile: testProfile },
        },
      });
      const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      await page.locator("#settings-profile-identity").waitFor({ timeout: 10_000 });
      const connect = await gateway.waitForRequest("connect");
      const selfInstanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(selfInstanceId).toBeTruthy();

      const avatarProfile = {
        ...testProfile,
        avatarMime: "image/png" as const,
        hasAvatar: true,
      };
      const upload = async (revision: string) => {
        const requestCountBefore = (await gateway.getRequests("users.setAvatar")).length;
        const updatedAtRevision = String(avatarProfile.updatedAt);
        const updatedAtRequestCountBefore = avatarRequests.filter(
          (url) => new URL(url).searchParams.get("v") === updatedAtRevision,
        ).length;
        await page.locator('input[type="file"]').setInputFiles({
          name: "avatar.png",
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=",
            "base64",
          ),
        });
        await expect
          .poll(async () => (await gateway.getRequests("users.setAvatar")).length)
          .toBe(requestCountBefore + 1);
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
        await gateway.resolveDeferred("users.setAvatar", {
          profile: avatarProfile,
          avatarRevision: revision,
        });
        await expect
          .poll(() => avatarRequests.some((url) => new URL(url).searchParams.get("v") === revision))
          .toBe(true);
        expect(
          avatarRequests.filter((url) => new URL(url).searchParams.get("v") === updatedAtRevision),
        ).toHaveLength(updatedAtRequestCountBefore);
      };

      await upload("first-content-hash-png");
      await gateway.deferNext("users.setAvatar");
      await upload("second-content-hash-png");

      const profileAvatar = page.locator("#settings-profile-identity openclaw-viewer-avatar");
      await expect
        .poll(() =>
          profileAvatar.evaluate(
            (element) =>
              (
                element as HTMLElement & {
                  user?: { avatarUrl?: string };
                }
              ).user?.avatarUrl,
          ),
        )
        .toBe(`/api/users/${testProfile.id}/avatar?v=second-content-hash-png`);
      expect(avatarProfile.updatedAt).toBe(testProfile.updatedAt);
    });
  });
});
