// Control UI tests cover the settings profile page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import {
  GIT_COAUTHOR_PREFERENCE_KEY,
  type UserModelAccount,
} from "../../../packages/gateway-protocol/src/index.ts";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-identity");
  }
});
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  const identity = page.locator("#settings-profile-identity");
  if (page.video()) {
    await writeFile(
      path.join(proofDir, name),
      await takeControlUiElementScreenshot(page, identity, [
        identity.locator(".settings-section__heading"),
      ]),
    );
  } else {
    await identity.screenshot({
      animations: "disabled",
      path: path.join(proofDir, name),
    });
  }
}

const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};
const githubAvatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4";
const linkedGitHubProfile = {
  ...testProfile,
  githubIdentity: {
    login: "octocat",
    profileUrl: "https://github.com/octocat",
    avatarUrl: githubAvatarUrl,
  },
};
const testPresenceUsers: NonNullable<ControlUiMockGatewayScenario["presenceUsers"]> = [
  {
    self: true,
    id: testProfile.id,
    name: testProfile.displayName,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${testProfile.updatedAt}`,
  },
];

suite.define(() => {
  async function openProfilePage(
    page: Page,
    methodResponses: Record<string, unknown> = {},
    presenceUsers = testPresenceUsers,
  ) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers,
      methodResponses: {
        "users.self": { profile: testProfile },
        "agents.list": {
          defaultId: "clipper",
          agents: [{ id: "clipper", name: "Clipper" }],
        },
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
        "Test Person",
      );
      await expect(page.locator(".profile-hero__handle").textContent()).resolves.toContain(
        "test@example.com",
      );
      await expect(page.locator(".profile-hero").textContent()).resolves.not.toContain("Clipper");
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

  it("wraps an unnamed user's long email in both hero fields on narrow screens", async () => {
    const longEmail = "primaryuserprimaryuserprimaryuserprimaryuserprimaryuser@example.test";
    await suite.withPage({ viewport: { width: 360, height: 800 } }, async ({ page }) => {
      await openProfilePage(
        page,
        { "users.self": { profile: { ...testProfile, displayName: null, emails: [longEmail] } } },
        testPresenceUsers.map((user) => ({ ...user, name: undefined, email: longEmail })),
      );

      const title = page.locator(".profile-hero__name");
      const handle = page.locator(".profile-hero__handle");
      await expect(title).toHaveText(longEmail);
      await expect(handle).toContainText(longEmail);
      for (const field of [title, handle]) {
        await expect(field).toBeInViewport({ ratio: 1 });
        expect(await field.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      expect(
        await page.locator("body").evaluate((element) => element.scrollWidth),
      ).toBeLessThanOrEqual(360);
    });
  });

  it("shows sign-in verification separately from explicit Git co-author credit", async () => {
    await suite.withPage(
      {
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
          : {}),
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        const avatarRequests: string[] = [];
        await page.route(githubAvatarUrl, async (route) => {
          avatarRequests.push(route.request().url());
          await route.fulfill({
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#24292f"/><circle cx="32" cy="27" r="14" fill="white"/><path d="M12 62c2-15 10-23 20-23s18 8 20 23" fill="white"/></svg>`,
            contentType: "image/svg+xml",
            status: 200,
          });
        });
        const gateway = await openProfilePage(page, {
          "users.self": {
            sequence: [{ profile: testProfile }, { profile: linkedGitHubProfile }],
          },
          "users.prefs.get": {
            status: "ok",
            entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
          },
          "users.prefs.set": { status: "ok" },
        });

        const githubRow = page
          .locator("#settings-profile-identity .settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: "GitHub account" }) });
        const coauthorRow = page.locator("#settings-profile-identity .settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: "Git co-author credit" }),
        });
        await expect(githubRow).toContainText("Unavailable");
        await expect(githubRow).toContainText("GitHub-backed sign-in");
        await expect(githubRow).toContainText("Refresh to retry");
        await expect(githubRow.locator(".settings-account")).toHaveCount(0);
        await expect(
          coauthorRow.getByRole("switch", { name: "Git co-author credit" }),
        ).toBeDisabled();
        await expect(page.getByRole("textbox", { name: "GitHub username" })).toHaveCount(0);
        await expect(
          page
            .locator("#settings-profile-identity")
            .getByRole("button", { name: /Link GitHub|Change|Disconnect/u }),
        ).toHaveCount(0);
        await screenshot(page, "08-github-identity-unlinked.png");

        await page.locator(".profile-refresh").click();
        await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);
        const prefGet = await gateway.waitForRequest("users.prefs.get");
        expect(prefGet.params).toEqual({ keys: [GIT_COAUTHOR_PREFERENCE_KEY] });
        const account = githubRow.getByRole("link", { name: "@octocat" });
        await expect(account).toBeVisible();
        await expect(account).toHaveAttribute("href", "https://github.com/octocat");
        await expect(account).toHaveAttribute("target", "_blank");
        await account.focus();
        await expect(account).toBeFocused();
        const avatar = account.locator("img");
        await expect(avatar).toBeVisible();
        await expect(avatar).toHaveAttribute("src", githubAvatarUrl);
        await expect
          .poll(() => avatar.evaluate((image) => (image as HTMLImageElement).naturalWidth))
          .toBe(64);
        expect(avatarRequests).toEqual([githubAvatarUrl]);
        await expect(githubRow).toContainText("Verified from your GitHub-backed sign-in");
        await expect(coauthorRow).toContainText("public GitHub noreply address");
        await expect(coauthorRow).toContainText("future commits only");
        const toggle = coauthorRow.getByRole("switch", { name: "Git co-author credit" });
        await expect(toggle).toBeEnabled();
        await expect(toggle).not.toBeChecked();
        await screenshot(page, "09-github-identity-linked.png");

        await coauthorRow.locator("wa-switch").click();
        const prefSet = await gateway.waitForRequest("users.prefs.set");
        expect(prefSet.params).toEqual({
          entries: { [GIT_COAUTHOR_PREFERENCE_KEY]: true },
        });
        await expect(toggle).toBeChecked();
        await screenshot(page, "10-git-coauthor-enabled.png");
      },
    );
  });

  it("credits a verified GitHub account by default with no stored preference", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      await openProfilePage(page, {
        "users.self": { profile: linkedGitHubProfile },
        "users.prefs.get": { status: "ok", entries: {} },
      });

      const coauthorRow = page.locator("#settings-profile-identity .settings-row").filter({
        has: page.locator(".settings-row__title", { hasText: "Git co-author credit" }),
      });
      const toggle = coauthorRow.getByRole("switch", { name: "Git co-author credit" });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await screenshot(page, "13-git-coauthor-default-on.png");
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
        const gateway = await openProfilePage(
          page,
          {
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
          },
          [],
        );

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
          await writeFile(
            path.join(proofDir, "06-authenticated-assistant-avatar.png"),
            await takeControlUiElementScreenshot(page, page.locator(".profile-hero"), [image]),
          );
        }
      },
    );
  });

  it("shares one authenticated avatar between the sidebar and profile preview", async () => {
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

  it("shows personal sign-in context and cancels or completes ChatGPT through recorded gateway status", async () => {
    await suite.withPage(
      {
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
          : {}),
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
        const personal: UserModelAccount = {
          authProfileId: "openai:scott",
          provider: "openai",
          label: "Test Person · Personal workspace",
          authType: "oauth",
          selected: true,
        };
        const work = {
          ...personal,
          authProfileId: "openai:work",
          label: "Test Person · Work workspace",
          selected: false,
        };
        const connected = {
          ...personal,
          authProfileId: "openai:personal",
          label: "Test Person · New workspace",
        };
        const savedAccounts = [personal, work];
        const inventory = (selected: UserModelAccount | null) => ({
          profileId: testProfile.id,
          accounts: savedAccounts.map((account) => ({
            ...account,
            selected: account.authProfileId === selected?.authProfileId,
          })),
          links: selected
            ? [
                {
                  provider: selected.provider,
                  authProfileId: selected.authProfileId,
                  updatedAt: 1_700_000_000_000,
                },
              ]
            : [],
        });
        const gateway = await openProfilePage(page, {
          "users.listModelAccounts": inventory(personal),
          "users.authConnect.catalog": {
            providers: [
              {
                id: "openai",
                label: "OpenAI",
                methods: [
                  { id: "browser", label: "Browser sign-in" },
                  { id: "api-key", label: "API key" },
                ],
              },
              { id: "xai", label: "Grok", methods: [{ id: "api-key", label: "API key" }] },
            ],
          },
          "users.authConnect.start": {
            sequence: [1, 2, 3].map((attempt) => ({
              connectId: `connect-${attempt}`,
              expiresAtMs: Date.now() + 60_000,
            })),
          },
          "users.authConnect.status": {
            status: "pending",
            step: {
              id: "redirect",
              type: "text",
              message: "Finish signing in, or paste the redirect URL here.",
              externalUrl: "https://auth.openai.com/oauth/authorize?state=demo-1",
            },
          },
        });
        // Anchor on the always-rendered manual-link row: the Sign in button swaps
        // for the flow UI once clicked, so it cannot identify the section.
        const section = page.locator("section.settings-section", {
          has: page.locator(".profile-auth-link-input"),
        });
        const captureAccounts = async (name: string, content: Locator) => {
          if (!captureUiProof) {
            return;
          }
          // Saved accounts and sign-in steps can exceed the viewport. Keep the
          // active control visible without resizing the page behind its recording.
          await content.scrollIntoViewIfNeeded();
          await writeFile(
            path.join(proofDir, name),
            await takeControlUiViewportScreenshot(page, section, [content]),
          );
        };
        const selectedAccount = section
          .locator(".settings-row")
          .filter({ has: page.locator(".profile-auth-link-unlink") });
        const contextRow = (title: string) =>
          section.locator(".settings-row").filter({
            has: page.locator(".settings-row__title", { hasText: new RegExp(`^${title}$`, "u") }),
          });
        let signInAttempt = 0;
        const startSignIn = async (providerId = "openai") => {
          signInAttempt += 1;
          await section.getByRole("button", { name: "Add account", exact: true }).click();
          const picker = section.locator(".profile-auth-provider");
          await picker.click();
          if (captureUiProof) {
            await expect(picker.locator('wa-option[value="xai"]')).toBeVisible();
            // Web Awesome exposes the options before the owning popup finishes fading in.
            await writeFile(
              path.join(proofDir, `connected-accounts-providers-${signInAttempt}.png`),
              await takeControlUiViewportScreenshot(
                page,
                picker.locator('wa-popup [part="popup"]'),
                [picker.locator('wa-option[value="xai"]')],
              ),
            );
          }
          await picker.locator(`wa-option[value="${providerId}"]`).click();
          if (providerId === "openai") {
            const methods = section.locator(".profile-auth-method");
            await methods.click();
            await methods.locator('wa-option[value="browser"]').click();
          }
          await expect(section.locator(".profile-auth-connect-start")).toHaveText("Sign in");
          await section.locator(".profile-auth-connect-start").click();
        };

        await expect(contextRow("Gateway")).toContainText(new URL(suite.server.baseUrl).host);
        await expect(contextRow("Person")).toContainText(testProfile.displayName);
        await expect(contextRow("Scope")).toContainText("Personal");
        await expect(section.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
        await expect(section.locator('input[type="password"]')).toHaveCount(0);

        await expect(selectedAccount.locator(".model-accounts__id").textContent()).resolves.toBe(
          personal.label,
        );
        await expect(
          selectedAccount.locator(".model-accounts__provider").textContent(),
        ).resolves.toContain("OpenAI");
        await expect(section.locator(".profile-auth-link-unlink").isEnabled()).resolves.toBe(true);
        await captureAccounts("model-accounts-linked.png", selectedAccount);

        await startSignIn();
        const openSignIn = section.locator(".wizard-step__external-link");
        await openSignIn.waitFor({ timeout: 10_000 });
        await expect(contextRow("Person")).toContainText(testProfile.displayName);
        await expect(openSignIn.getAttribute("href")).resolves.toBe(
          "https://auth.openai.com/oauth/authorize?state=demo-1",
        );
        await expect(section.locator("#profile-account-auth-answer")).toBeVisible();
        await expect(section.locator(".wizard-step__message")).toHaveText(
          "Finish signing in, or paste the redirect URL here.",
        );
        await captureAccounts(
          "model-accounts-flow.png",
          section.locator("#profile-account-auth-answer"),
        );

        await gateway.deferNext("users.authConnect.cancel");
        await section.locator(".profile-auth-connect-cancel").click();
        const cancellation = await gateway.waitForRequest("users.authConnect.cancel");
        expect(cancellation.params).toEqual({ profileId: testProfile.id, connectId: "connect-1" });
        await expect(section.locator(".model-accounts-flow")).toBeVisible();
        await expect(section.locator(".profile-auth-connect-cancel")).toBeDisabled();
        await gateway.resolveDeferred("users.authConnect.cancel", { status: "cancelled" });
        await expect(section.locator(".model-accounts-flow")).toHaveCount(0);
        await expect(section.locator('[role="status"]')).toContainText("Sign-in cancelled.");
        await expect(selectedAccount.locator(".model-accounts__id")).toHaveText(personal.label);
        await captureAccounts("model-accounts-cancelled.png", section.locator('[role="status"]'));

        await gateway.setMethodResponse("users.authConnect.status", {
          status: "pending",
          step: { id: "saving", type: "progress", executor: "gateway", message: "Saving account…" },
        });
        await startSignIn();
        await expect(section.locator(".wizard-step__progress")).toHaveText("Saving account…");
        await page.locator(".profile-refresh").click();
        await expect.poll(async () => (await gateway.getRequests("users.self")).length).toBe(2);
        await expect(section.locator(".profile-auth-connect-cancel")).toBeEnabled();
        await captureAccounts(
          "model-accounts-saving.png",
          section.locator(".wizard-step__progress"),
        );
        savedAccounts.push(connected);
        await gateway.setMethodResponse("users.listModelAccounts", inventory(connected));
        await gateway.setMethodResponse("users.authConnect.status", {
          status: "connected",
          authProfileId: "openai:personal",
          links: [
            { provider: "openai", authProfileId: "openai:personal", updatedAt: 1_700_000_000_000 },
          ],
        });
        await expect(section.locator(".model-accounts-flow")).toHaveCount(0);
        await expect(selectedAccount.locator(".model-accounts__id")).toHaveText(connected.label);
        await expect(section.locator('[role="status"]')).toContainText("Account added.");
        await expect(section.locator(".profile-auth-add-account")).toBeEnabled();
        const polls = await gateway.getRequests("users.authConnect.status");
        expect(polls.at(-1)?.params).toEqual({ profileId: testProfile.id, connectId: "connect-2" });
        await captureAccounts("model-accounts-connected.png", selectedAccount);
        await gateway.setMethodResponse("users.selectModelAccount", {
          links: inventory(work).links,
        });
        await gateway.setMethodResponse("users.listModelAccounts", inventory(work));
        await section.locator(`[data-auth-profile-id="${work.authProfileId}"]`).click();
        const selection = await gateway.waitForRequest("users.selectModelAccount");
        expect(selection.params).toEqual({
          profileId: testProfile.id,
          authProfileId: work.authProfileId,
        });
        await expect(selectedAccount.locator(".model-accounts__id")).toHaveText(work.label);
        await expect(section.locator(".model-accounts-notice")).toContainText(
          "Existing chats are unchanged.",
        );
        await captureAccounts("model-accounts-default-selected.png", selectedAccount);
        await gateway.setMethodResponse("users.unlinkAuthProfile", { links: [] });
        await gateway.setMethodResponse("users.listModelAccounts", inventory(null));
        await section.getByRole("button", { name: "Use gateway default", exact: true }).click();
        await expect(selectedAccount).toHaveCount(0);
        await expect(section.locator(".profile-auth-account-select")).toHaveCount(3);
        await expect(section.locator(".model-accounts-notice")).toContainText(
          "Saved credentials and existing chats are unchanged.",
        );
        await captureAccounts(
          "model-accounts-default-cleared.png",
          section.locator(".model-accounts-notice"),
        );

        const grok: UserModelAccount = {
          authProfileId: "xai:personal",
          provider: "xai",
          label: "Test Person · Grok",
          authType: "api_key",
          selected: true,
        };
        await gateway.setMethodResponse("users.authConnect.status", {
          status: "pending",
          step: {
            id: "api-key",
            type: "text",
            sensitive: true,
            message: "Enter your Grok API key",
          },
        });
        await startSignIn("xai");
        const keyInput = section.locator("#profile-account-auth-answer");
        await expect(keyInput).toHaveAttribute("type", "password");
        await keyInput.fill("synthetic-grok-key");
        await gateway.deferNext("users.authConnect.answer");
        await captureAccounts("connected-accounts-grok-input.png", keyInput);
        await section.locator('.wizard-step__form button[type="submit"]').click();
        const answer = await gateway.waitForRequest("users.authConnect.answer");
        expect(answer.params).toEqual({
          profileId: testProfile.id,
          connectId: "connect-3",
          stepId: "api-key",
          value: "synthetic-grok-key",
        });
        await expect(keyInput).toHaveValue("");
        await expect(keyInput).toBeDisabled();
        savedAccounts.push(grok);
        await gateway.setMethodResponse("users.listModelAccounts", inventory(grok));
        await gateway.resolveDeferred("users.authConnect.answer", {
          status: "connected",
          authProfileId: grok.authProfileId,
          links: inventory(grok).links,
        });
        await expect(selectedAccount.locator(".model-accounts__id")).toHaveText(grok.label);
        await expect(section.locator('input[type="password"]')).toHaveCount(0);
        await expect(section.locator(".model-accounts-notice")).toHaveText("Account added.");
        await captureAccounts("connected-accounts-grok-added.png", selectedAccount);
      },
    );
  });

  it("keeps identity refresh single-flight and retries after a failed request", async () => {
    await suite.withPage(
      {
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
          : {}),
        viewport: { width: 1280, height: 800 },
      },
      async ({ page }) => {
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

        await gateway.rejectDeferred("users.self", {
          message: "identity unavailable: OPENAI_API_KEY=sk-1234567890abcdef",
        });
        await page
          .getByText("identity unavailable: OPENAI_API_KEY=sk-123...cdef", { exact: true })
          .waitFor({ timeout: 10_000 });
        await expect(page.getByText("sk-1234567890abcdef").count()).resolves.toBe(0);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        expect(await refresh.ariaSnapshot()).toContain('button "Refresh"');
        await screenshot(page, "07-redacted-identity-error.png");

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
      },
    );
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
        const chooser = page.locator(".identity-avatar-control > button");
        await expect(chooser).toHaveAccessibleName("Choose image");
        await chooser.focus();
        await expect(chooser).toBeFocused();
        await screenshot(page, `11-avatar-keyboard-focus-${revision}.png`);
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser"),
          chooser.press("Enter"),
        ]);
        await fileChooser.setFiles({
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
        await screenshot(page, `12-avatar-action-disabled-${revision}.png`);
        await expect(chooser).toBeDisabled();
        await expect
          .poll(() => chooser.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("0.5");
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
