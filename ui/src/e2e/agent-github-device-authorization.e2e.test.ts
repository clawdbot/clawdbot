// Settings proof uses real navigation and controls with synthetic Gateway accounts.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI GitHub connections",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-github-device-authorization");
  }
});
const pageOptions = () => ({
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 960, width: 1280 },
  ...(captureUiProof ? { recordVideo: { dir: proofDir, size: { height: 960, width: 1280 } } } : {}),
});
async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".settings-workspace"), [
      page.locator(".settings-section").first(),
    ]),
  );
}
async function assertDeviceCodeCopy(page: Page, userCode: string) {
  const deviceCode = page.getByText(userCode, { exact: true });
  const authorizationHint = page.getByText(
    "Open GitHub yourself, then enter the one-time code shown here.",
    { exact: true },
  );
  await authorizationHint.dblclick();
  expect(await page.evaluate(() => globalThis.getSelection()?.toString())).not.toBe("");
  await deviceCode.click();
  expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe(userCode);
  const copyCode = page.getByRole("button", { name: "Copy code", exact: true });
  const codeBox = await deviceCode.boundingBox();
  const copyBox = await copyCode.boundingBox();
  if (!codeBox || !copyBox) {
    throw new Error("Device code and copy button must be visible");
  }
  expect(Math.abs(codeBox.y + codeBox.height / 2 - copyBox.y - copyBox.height / 2)).toBeLessThan(4);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await copyCode.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(userCode);
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
}
const profileId = "11111111-1111-4111-8111-111111111111";
const presenceUsers = [{ self: true, id: profileId, name: "Test Person" }];
const systemOAuth = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-octocat" },
  gitAuthor: { name: "System Octocat", email: null },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["gist", "read:org", "repo", "workflow"],
  repositoryGrants: "unknown",
} as const;
const agentPat = {
  ...systemOAuth,
  source: "agent-override",
  credentialKind: "managed-pat",
  account: { login: "agent-octocat" },
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  oauthScopes: [],
} as const;
const systemStatus = {
  agentId: "main",
  selectedScope: "system",
  selected: { scope: "system", configured: true, identity: systemOAuth },
  effective: agentPat,
} as const;
const agentStatus = {
  agentId: "main",
  selectedScope: "agent",
  selected: { scope: "agent", configured: true, identity: agentPat },
  effective: agentPat,
} as const;
const disconnected = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
} as const;
const personal = {
  ...disconnected,
  state: "connected",
  generation: "22222222-2222-4222-8222-222222222222",
  account: { accountId: 2, login: "personal-octocat" },
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
} as const;
const device = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresInMs: 60_000,
  pollAfterMs: 1_000,
} as const;
const config = { agents: { entries: { main: { default: true } } } };
const configResponse = {
  config,
  sourceConfig: config,
  runtimeConfig: config,
  hash: "github-config-hash",
  issues: [],
  raw: JSON.stringify(config),
  valid: true,
};

suite.define(() => {
  it("preserves unidentified System management and keeps agent overrides advanced and distinct", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        methodResponses: {
          "config.get": configResponse,
          "tools.github.status": {
            cases: [
              { match: { selectedScope: "system" }, response: systemStatus },
              { match: { selectedScope: "agent" }, response: agentStatus },
            ],
          },
          "tools.catalog": { agentId: "main", profiles: [], groups: [] },
          "tools.effective": { agentId: "main", profile: "full", groups: [], notices: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const section = page.locator("#settings-profile-github-connections");
      await expect(section.getByText("Personal sign-in required", { exact: true })).toBeVisible();
      await expect(section.locator('[data-github-connection="system"]')).toContainText(
        "@system-octocat",
      );
      await expect(section).not.toContainText("@agent-octocat");
      expect(await gateway.getRequests("users.github.status")).toHaveLength(0);
      await capture(page, "01-unidentified-system.png");
      await section.getByRole("button", { name: "Change System GitHub" }).click();
      await expect(section.getByText("For the system", { exact: true })).toBeVisible();
      await gateway.deferNext("tools.github.authorize.start");
      await section.getByRole("button", { name: "Continue with GitHub" }).click();
      expect((await gateway.waitForRequest("tools.github.authorize.start")).params).toEqual({
        agentId: "main",
        scope: "system",
      });
      await gateway.deferNext("tools.github.authorize.poll");
      await gateway.resolveDeferred("tools.github.authorize.start", device);
      await expect(section.getByText(device.userCode, { exact: true })).toBeVisible();
      await expect(
        section.getByRole("link", { name: "Open github.com/login/device" }),
      ).toHaveAttribute("href", device.verificationUri);
      await capture(page, "02-system-code.png");
      await assertDeviceCodeCopy(page, device.userCode);
      await capture(page, "02b-system-code-copied.png");
      await gateway.waitForRequest("tools.github.authorize.poll");
      const configReads = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("tools.github.authorize.poll");
      await gateway.resolveDeferred("tools.github.authorize.poll", {
        status: "slow_down",
        retryAfterMs: 1_000,
      });
      await expect(
        section.getByText("GitHub asked us to wait longer…", { exact: true }),
      ).toBeVisible();
      expect(await gateway.getRequests("config.get")).toHaveLength(configReads);
      await capture(page, "03-system-pending.png");
      await gateway.waitForRequest("tools.github.authorize.poll", { after: 1 });
      await gateway.resolveDeferred("tools.github.authorize.poll", {
        status: "success",
        githubStatus: systemStatus,
      });
      await expect(section.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
      await expect(section.getByText("For the system", { exact: true })).toBeVisible();
      await capture(page, "04-system-connected.png");
      await section.getByRole("button", { name: "Use a PAT instead" }).click();
      await expect(section.getByLabel("Fine-grained PAT", { exact: true })).toBeVisible();
      await expect(section.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
      await capture(page, "05-system-pat.png");
      await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
      await expect(page.getByText("@agent-octocat", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with GitHub" })).not.toBeVisible();
      await page.getByText("Advanced: agent GitHub override", { exact: true }).click();
      await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
      await capture(page, "06-advanced-agent-override.png");
      await page.getByRole("button", { name: "Manage connections in Profile" }).click();
      await expect(page).toHaveURL(/settings\/profile#settings-profile-github-connections$/);
    });
  });

  it("lets an identified reader connect, reconnect and disconnect only My GitHub", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        presenceUsers,
        methodResponses: { "users.github.status": { personal: disconnected, system: systemOAuth } },
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const section = page.locator("#settings-profile-github-connections");
      await expect(section.locator('[data-github-connection="system"]')).toContainText(
        "@system-octocat",
      );
      await expect(section.getByRole("button", { name: "Change System GitHub" })).toHaveCount(0);
      expect(await gateway.getRequests("users.self")).toHaveLength(0);
      const configReads = (await gateway.getRequests("config.get")).length;
      const configWrites = (await gateway.getRequests("config.set")).length;
      await section.getByRole("button", { name: "Connect My GitHub" }).click();
      await expect(section.getByText("For me", { exact: true })).toBeVisible();
      await expect(section.getByText("For the system", { exact: true })).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Use a PAT instead" })).toHaveCount(0);
      for (const [index, connection] of [
        personal,
        {
          ...personal,
          generation: "44444444-4444-4444-8444-444444444444",
          account: { accountId: 4, login: "second-octocat" },
        },
      ].entries()) {
        await gateway.deferNext("users.github.authorize.start");
        await section.getByRole("button", { name: "Continue with GitHub" }).click();
        expect(
          (await gateway.waitForRequest("users.github.authorize.start", { after: index })).params,
        ).toEqual({});
        await gateway.deferNext("users.github.authorize.poll");
        await gateway.resolveDeferred("users.github.authorize.start", {
          ...device,
          userCode: index ? "NEXT-1234" : device.userCode,
        });
        await expect(
          section.getByText(index ? "NEXT-1234" : device.userCode, { exact: true }),
        ).toBeVisible();
        await capture(page, `07-personal-code-${index}.png`);
        await assertDeviceCodeCopy(page, index ? "NEXT-1234" : device.userCode);
        await capture(page, `07b-personal-code-copied-${index}.png`);
        await gateway.waitForRequest("users.github.authorize.poll", { after: index });
        await gateway.resolveDeferred("users.github.authorize.poll", {
          status: "success",
          personal: connection,
        });
        await expect(section.locator('[data-github-connection="personal"]')).toContainText(
          `@${connection.account.login}`,
        );
        await expect(section.locator('[data-github-connection="system"]')).toContainText(
          "@system-octocat",
        );
        await capture(page, `08-personal-connected-${index}.png`);
      }
      await gateway.setMethodResponse("users.github.status", {
        personal: disconnected,
        system: systemOAuth,
      });
      await section.getByRole("button", { name: "Disconnect My GitHub" }).click();
      expect((await gateway.waitForRequest("users.github.disconnect")).params).toEqual({});
      await expect(section.locator('[data-github-connection="personal"]')).toContainText(
        "Not connected",
      );
      await expect(section).not.toContainText("@second-octocat");
      expect(await gateway.getRequests("config.get")).toHaveLength(configReads);
      expect(await gateway.getRequests("config.set")).toHaveLength(configWrites);
      expect(await gateway.getRequests("tools.github.authorize.start")).toHaveLength(0);
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
      await capture(page, "09-reader-disconnected.png");
    });
  });

  it("defaults an identified admin to For me and preserves verified identity and credit", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const avatarUrl = "https://avatars.githubusercontent.com/u/1?v=4";
      await page.route(avatarUrl, (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12" fill="gray"/></svg>',
        }),
      );
      const profile = {
        id: profileId,
        displayName: "Test Person",
        avatarMime: null,
        mergedInto: null,
        createdAt: 1,
        updatedAt: 2,
        emails: [],
        hasAvatar: false,
        githubIdentity: {
          login: "signin-octocat",
          profileUrl: "https://github.com/signin-octocat",
          avatarUrl,
        },
      };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        presenceUsers,
        methodResponses: {
          "config.get": configResponse,
          "users.self": { profile },
          "users.prefs.get": { status: "ok", entries: {} },
          "users.github.status": { personal: disconnected, system: systemOAuth },
          "tools.github.status": systemStatus,
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const section = page.locator("#settings-profile-github-connections");
      const signIn = page.locator("#settings-profile-identity");
      await expect(signIn).toContainText("@signin-octocat");
      await section.getByRole("button", { name: "Manage connections", exact: true }).click();
      await expect(section.getByRole("radio", { name: "For me", exact: true })).toBeChecked();
      await gateway.deferNext("users.github.authorize.start");
      await section.getByRole("button", { name: "Continue with GitHub" }).click();
      await gateway.deferNext("users.github.authorize.poll");
      await gateway.resolveDeferred("users.github.authorize.start", device);
      await expect(section.getByRole("radio", { name: "For me", exact: true })).toBeChecked();
      await capture(page, "10-admin-for-me.png");
      await gateway.waitForRequest("users.github.authorize.poll");
      await gateway.resolveDeferred("users.github.authorize.poll", { status: "success", personal });
      await expect(section.locator('[data-github-connection="personal"]')).toContainText(
        "@personal-octocat",
      );
      await expect(signIn).toContainText("@signin-octocat");
      await expect(
        signIn.getByRole("button", { name: /Link GitHub|Change|Disconnect/ }),
      ).toHaveCount(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
      await section.getByRole("button", { name: "Change System GitHub" }).click();
      await expect(
        section.getByRole("radio", { name: "For the system", exact: true }),
      ).toBeChecked();
      await capture(page, "11-admin-explicit-system.png");
    });
  });

  it("invalidates an old personal flow when the authenticated profile changes", async () => {
    await suite.withPage(pageOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        presenceUsers,
        methodResponses: { "users.github.status": { personal: disconnected, system: systemOAuth } },
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      const section = page.locator("#settings-profile-github-connections");
      await section.getByRole("button", { name: "Connect My GitHub" }).click();
      await gateway.deferNext("users.github.authorize.start");
      await section.getByRole("button", { name: "Continue with GitHub" }).click();
      await gateway.waitForRequest("users.github.authorize.start");
      await gateway.resolveDeferred("users.github.authorize.start", {
        ...device,
        pollAfterMs: 60_000,
      });
      await expect(section.getByText(device.userCode, { exact: true })).toBeVisible();
      const connect = await gateway.waitForRequest("connect");
      const instanceId = (connect.params as { client: { instanceId: string } }).client.instanceId;
      const reads = (await gateway.getRequests("users.github.status")).length;
      await gateway.emitGatewayEvent("presence", {
        presence: [
          {
            instanceId,
            mode: "webchat",
            reason: "connect",
            user: { id: "55555555-5555-4555-8555-555555555555", name: "Second Person" },
            watchedSessions: [],
          },
        ],
      });
      await gateway.waitForRequest("users.github.status", { after: reads });
      await gateway.waitForRequest("users.github.authorize.cancel");
      await expect(section.getByText(device.userCode, { exact: true })).toHaveCount(0);
      await expect(section.locator('[data-github-connection="personal"]')).toContainText(
        "Not connected",
      );
      await capture(page, "12-profile-switch-fenced.png");
    });
  });
});
