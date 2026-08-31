// Control UI E2E proves the complete Agents -> Tools GitHub authorization presentation.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent GitHub device authorization",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "agent-github-device-authorization",
);

async function capture(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

const nativeUnavailable = {
  source: "system-detected",
  credentialKind: "native",
  credentialState: "unavailable",
  account: null,
  gitAuthor: { name: null, email: null },
  evidence: "none",
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  oauthScopes: [],
  repositoryGrants: "unknown",
} as const;

const systemOAuth = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-octocat" },
  gitAuthor: { name: "System Octocat", email: "1+system@users.noreply.github.com" },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["gist", "read:org", "repo", "workflow"],
  repositoryGrants: "unknown",
} as const;

const agentPat = {
  source: "agent-override",
  credentialKind: "managed-pat",
  credentialState: "available",
  account: { login: "agent-octocat" },
  gitAuthor: { name: "Agent Octocat", email: null },
  evidence: "github-api",
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  oauthScopes: [],
  repositoryGrants: "unknown",
} as const;

const initialStatus = {
  agentId: "main",
  selectedScope: "system",
  selected: { scope: "system", configured: false, identity: null },
  effective: nativeUnavailable,
} as const;

const systemStatus = {
  agentId: "main",
  selectedScope: "system",
  selected: { scope: "system", configured: true, identity: systemOAuth },
  effective: systemOAuth,
} as const;

const agentStatus = {
  agentId: "main",
  selectedScope: "agent",
  selected: { scope: "agent", configured: true, identity: agentPat },
  effective: agentPat,
} as const;

const shadowedSystemStatus = {
  agentId: "main",
  selectedScope: "system",
  selected: { scope: "system", configured: true, identity: systemOAuth },
  effective: agentPat,
} as const;

const expiredAgentOAuth = {
  ...systemOAuth,
  source: "agent-override" as const,
  credentialState: "configured_unavailable" as const,
  account: { login: "agent-octocat" },
  gitAuthor: { name: "Agent Octocat", email: "2+agent@users.noreply.github.com" },
  refreshState: "expired" as const,
};

const expiredAgentStatus = {
  agentId: "main",
  selectedScope: "agent",
  selected: { scope: "agent", configured: true, identity: expiredAgentOAuth },
  effective: expiredAgentOAuth,
} as const;

suite.define(() => {
  it("shows code, pending, connected scopes, expiry, PAT fallback, and disconnect states", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 960, width: 1280 },
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { height: 960, width: 1280 } } }
          : {}),
      },
      async ({ page }) => {
        const config = { agents: { entries: { main: { default: true } } } };
        const gateway = await installMockGateway(page, {
          assistantName: "Main agent",
          defaultAgentId: "main",
          methodResponses: {
            "agents.list": {
              agents: [{ id: "main", name: "Main agent" }],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "config.get": {
              config,
              sourceConfig: config,
              runtimeConfig: config,
              hash: "github-config-hash-1",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "tools.catalog": { agentId: "main", profiles: [], groups: [] },
            "tools.effective": { agentId: "main", profile: "full", groups: [], notices: [] },
            "tools.github.status": {
              sequence: [initialStatus, agentStatus, shadowedSystemStatus, expiredAgentStatus],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
        await gateway.waitForRequest("tools.github.status");
        await page.getByRole("button", { name: "Connect GitHub" }).waitFor();
        await capture(page, "00-disconnected.png");

        await gateway.deferNext("tools.github.authorize.start");
        await page.getByRole("button", { name: "Connect GitHub" }).click();
        const start = await gateway.waitForRequest("tools.github.authorize.start");
        expect(start.params).toEqual({ agentId: "main", scope: "system" });
        await gateway.resolveDeferred("tools.github.authorize.start", {
          requestId: "github-device-11111111111111111111111111111111",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 1_000,
        });
        const deviceCode = page.getByText("ABCD-1234", { exact: true });
        await deviceCode.waitFor();
        await capture(page, "01-code.png");
        const authorizationHint = page.getByText(
          "GitHub CLI account and Git author for local agent tools and the Codex harness.",
          { exact: true },
        );
        await authorizationHint.dblclick();
        expect(await page.evaluate(() => globalThis.getSelection()?.toString())).not.toBe("");
        await deviceCode.click();
        expect(await page.evaluate(() => globalThis.getSelection()?.toString())).toBe("ABCD-1234");
        const copyCode = page.getByRole("button", { name: "Copy code", exact: true });
        const codeBox = await deviceCode.boundingBox();
        const copyBox = await copyCode.boundingBox();
        if (!codeBox || !copyBox) {
          throw new Error("Device code and copy button must be visible");
        }
        expect(
          Math.abs(codeBox.y + codeBox.height / 2 - copyBox.y - copyBox.height / 2),
        ).toBeLessThan(4);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await copyCode.click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("ABCD-1234");
        await page.getByRole("button", { name: "Copied!", exact: true }).waitFor();
        const openGitHub = page.getByRole("link", { name: "Open github.com/login/device" });
        expect(await openGitHub.getAttribute("href")).toBe("https://github.com/login/device");
        expect(await page.locator(".settings-secret input").count()).toBe(0);
        await capture(page, "01b-code-copied.png");

        await gateway.deferNext("tools.github.authorize.poll");
        await gateway.waitForRequest("tools.github.authorize.poll");
        await gateway.deferNext("tools.github.authorize.poll");
        await gateway.resolveDeferred("tools.github.authorize.poll", {
          status: "pending",
          retryAfterMs: 1_000,
        });
        await page.getByText("Waiting for approval…", { exact: true }).waitFor();
        await capture(page, "02-pending.png");

        await gateway.waitForRequest("tools.github.authorize.poll", { after: 1 });
        await gateway.deferNext("tools.github.authorize.poll");
        await gateway.resolveDeferred("tools.github.authorize.poll", {
          status: "slow_down",
          retryAfterMs: 1_000,
        });
        await page.getByText("GitHub asked us to wait longer…", { exact: true }).waitFor();
        await capture(page, "02b-slow-down.png");

        await gateway.waitForRequest("tools.github.authorize.poll", { after: 2 });
        await gateway.resolveDeferred("tools.github.authorize.poll", {
          status: "success",
          githubStatus: systemStatus,
        });
        await page.getByText("@system-octocat", { exact: true }).waitFor();
        await page.getByText("Managed GitHub authorization", { exact: true }).waitFor();
        await capture(page, "03-connected-system.png");

        const githubSection = page.locator(".settings-section", { hasText: "GitHub Identity" });
        await githubSection.getByText("This Agent", { exact: true }).click();
        await gateway.waitForRequest("tools.github.status", { after: 1 });
        await page.getByText("@agent-octocat", { exact: true }).waitFor();
        await page.getByText("Managed personal access token", { exact: true }).waitFor();
        await capture(page, "04-connected-agent.png");

        await githubSection.getByText("System", { exact: true }).click();
        await gateway.waitForRequest("tools.github.status", { after: 2 });
        await page.getByText("@system-octocat", { exact: true }).waitFor();
        await page.getByText("@agent-octocat", { exact: true }).waitFor();
        expect(await page.getByText("Managed GitHub authorization", { exact: true }).count()).toBe(
          1,
        );
        expect(await page.getByText("Managed personal access token", { exact: true }).count()).toBe(
          1,
        );
        await capture(page, "04b-system-shadowed.png");

        await githubSection.getByText("This Agent", { exact: true }).click();
        await gateway.waitForRequest("tools.github.status", { after: 3 });
        await page.getByText("Expired — reconnect required", { exact: true }).waitFor();
        await capture(page, "05-refresh-expired.png");

        await gateway.deferNext("tools.github.authorize.start");
        await page.getByRole("button", { name: "Connect GitHub" }).click();
        await gateway.waitForRequest("tools.github.authorize.start", { after: 1 });
        await gateway.deferNext("tools.github.authorize.poll");
        await gateway.resolveDeferred("tools.github.authorize.start", {
          requestId: "github-device-22222222222222222222222222222222",
          userCode: "WXYZ-9876",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 1_000,
        });
        await gateway.waitForRequest("tools.github.authorize.poll", { after: 3 });
        await gateway.resolveDeferred("tools.github.authorize.poll", { status: "expired" });
        await page.getByText(/one-time code expired/).waitFor();
        await capture(page, "05b-device-code-expired.png");

        await page.getByRole("button", { name: "Use a PAT instead" }).click();
        await page.getByLabel("Fine-grained PAT").waitFor();
        expect(await page.getByRole("button", { name: "Connect GitHub" }).count()).toBe(0);
        await capture(page, "06-pat-fallback.png");
        await page.getByRole("button", { name: "Cancel" }).click();

        await gateway.deferNext("tools.github.authorize.start");
        await page.getByRole("button", { name: "Connect GitHub" }).click();
        await gateway.waitForRequest("tools.github.authorize.start", { after: 2 });
        await gateway.resolveDeferred("tools.github.authorize.start", {
          requestId: "github-device-33333333333333333333333333333333",
          userCode: "DISC-0001",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 5_000,
        });
        await page.getByText("DISC-0001", { exact: true }).waitFor();
        await gateway.setOnline(false);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime?: { context: { gateway: { snapshot: { phase: string } } } };
              };
              return app.runtime?.context.gateway.snapshot.phase;
            }),
          )
          .not.toBe("connected");
        await capture(page, "07-disconnected.png");
      },
    );
  });
});
