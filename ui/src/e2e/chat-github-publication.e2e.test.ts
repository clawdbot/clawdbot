import path from "node:path";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  personalAccount,
  personalGeneration,
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI personal GitHub publication" });

async function newPublicationContext() {
  return await suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
    ...(captureUiProof
      ? { recordVideo: { dir: suite.artifactDir, size: { width: 1180, height: 800 } } }
      : {}),
  });
}

suite.define(() => {
  it.each([1180, 390])(
    "keeps a sole publisher compact and keyboard accessible at %ipx",
    async (width) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": { ...publicationOptions, personal: null },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      const arrow = page.getByRole("button", { name: "Publication account" });
      await arrow.waitFor();
      const account = page.locator("[data-publication-account]");
      expect(await account.isVisible()).toBe(false);
      expect(await page.getByRole("combobox", { name: "Publication account" }).count()).toBe(0);
      const row = page.locator('.chat-pr[data-state="branch"]');
      const closedBounds = await row.boundingBox();
      expect(closedBounds).not.toBeNull();
      await arrow.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => arrow.getAttribute("aria-expanded")).toBe("true");
      await account.waitFor();
      expect(await account.textContent()).toContain("Publish as @system-bot");
      expect((await row.boundingBox())?.height).toBe(closedBounds?.height);
      const accountBounds = await account.boundingBox();
      expect(accountBounds).not.toBeNull();
      expect(accountBounds!.x).toBeGreaterThanOrEqual(0);
      expect(accountBounds!.x + accountBounds!.width).toBeLessThanOrEqual(width);
      await expect
        .poll(() =>
          account.evaluate((element) => element.closest("wa-popover") === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => arrow.getAttribute("aria-expanded")).toBe("false");
      await account.waitFor({ state: "hidden" });
      await expect
        .poll(() => arrow.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await showPublicationBranch(gateway, "openclaw/updated-branch");
      await row
        .getByText("openclaw/updated-branch", { exact: true })
        .waitFor({ state: "attached" });
      await arrow.click();
      await account.waitFor();
      await page.locator(".chat-thread").click();
      await expect.poll(() => arrow.getAttribute("aria-expanded")).toBe("false");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("requires an explicit choice when only a personal account is connected", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": { ...publicationOptions, shared: null },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    const publish = page.getByRole("button", { name: "Publish PR" });
    await expect.poll(() => publish.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Publication account" }).click();
    await page.getByRole("combobox", { name: "Publication account" }).selectOption("personal");
    await expect.poll(() => publish.isEnabled()).toBe(true);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    await page.keyboard.press("Escape");
    await gateway.deferNext("sessions.github.publish");
    await publish.click();
    const request = await gateway.waitForRequest("sessions.github.publish");
    expect(request.params).toMatchObject({
      selection: { source: "personal", generation: personalGeneration, account: personalAccount },
    });
  });

  it.each([
    { name: "reclaimed", state: "reclaimed", running: false, conflict: false, ready: true },
    { name: "remote", state: "active", running: false, conflict: false, ready: false },
    { name: "running", state: "reclaimed", running: true, conflict: false, ready: false },
    { name: "conflicted", state: "reclaimed", running: false, conflict: true, ready: false },
  ])(
    "gates personal publication for a $name workspace",
    async ({ name, state, running, conflict, ready }) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        sessions: [
          createControlUiSessionRow("agent:main:main", "Publication workspace", now, {
            hasActiveRun: running,
            status: running ? "running" : "done",
            placement: {
              state,
              generation: 1,
              createdAtMs: now,
              updatedAtMs: now,
              stateChangedAtMs: now,
              ...(conflict
                ? {
                    workspaceResultConflict: {
                      paths: ["src/example.ts"],
                      stagedResultRef: "refs/openclaw/worker-results/test",
                      totalCount: 1,
                    },
                  }
                : {}),
            },
          }),
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      await page.getByRole("button", { name: "Publication account" }).click();
      await page.getByRole("combobox", { name: "Publication account" }).selectOption("personal");
      await page.keyboard.press("Escape");
      const publish = page.getByRole("button", { name: "Publish PR" });
      await publish.waitFor();
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, `${name}-workspace.png`),
        });
      }
      await expect.poll(() => publish.isEnabled()).toBe(ready);
      if (conflict) {
        const notice = page.locator(".chat-workspace-conflict-notice");
        await notice.getByRole("button", { name: "Dismiss workspace conflict notice" }).click();
        await notice.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Publication account" }).click();
        await page.getByRole("combobox", { name: "Publication account" }).waitFor();
      }
    },
  );

  it("freezes an explicitly selected personal account through a lost response and shows the server actor", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      presenceUsers: [
        { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await page.getByRole("button", { name: "Publication account" }).click();
    const chooser = page.getByRole("combobox", { name: "Publication account" });
    await expect.poll(() => chooser.inputValue()).toBe("shared");
    await chooser.selectOption("personal");
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    await page.keyboard.press("Escape");
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    const first = await gateway.waitForRequest("sessions.github.publish");
    expect(first.params).toEqual({
      sessionKey: "agent:main:main",
      idempotencyKey: expect.any(String),
      selection: { source: "personal", generation: personalGeneration, account: personalAccount },
    });
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Response lost.",
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).count())
      .toBe(1);
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.setMethodResponse("sessions.github.options", {
      ...publicationOptions,
      personal: {
        ...publicationOptions.personal,
        generation: "other-generation",
        account: { accountId: 4, login: "replacement" },
      },
    });
    await page.getByRole("button", { name: "Refresh publication" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).isEnabled())
      .toBe(true);
    await expect.poll(() => chooser.count()).toBe(0);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    expect(await page.locator(".chat-pr__publication-outcome").textContent()).not.toContain(
      "replacement",
    );
    await gateway.setMethodResponse("sessions.github.publish", {
      requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b2",
      status: "failed",
      code: "identity_changed",
      publisher: { source: "personal", ...personalAccount },
      message: "The selected connection changed.",
      nextAction: "Review the account and choose a new publication.",
    });
    await page.getByRole("button", { name: "Retry publication" }).click();
    const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(second.params).toEqual(first.params);
    await expect
      .poll(() => page.getByRole("button", { name: "Choose a new publication" }).count())
      .toBe(1);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    await expect
      .poll(() => page.locator(".chat-pr__publication-outcome").textContent())
      .toContain("My GitHub");
    expect(await gateway.getRequests("secrets.set")).toHaveLength(0);
    if (captureUiProof) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(suite.artifactDir, "05-personal-identity-changed.png"),
      });
    }
  });

  it.each(["local", "reclaimed"])(
    "recovers the original personal request in a %s workspace and confirms its account, target, and snapshot",
    async (state) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b3";
      const confirmation = {
        requestDigest: "a".repeat(64),
        generation: personalGeneration,
        account: personalAccount,
        repository: "team/demo",
        pushRepository: "alice/demo",
        baseBranch: "main",
        branch: "feature/original",
        sourceHeadCommit: "1".repeat(40),
        sourceIndexTree: "2".repeat(40),
        workspaceTree: "3".repeat(40),
      };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        sessions: [
          createControlUiSessionRow("agent:main:main", "Publication workspace", Date.now(), {
            placement: {
              state,
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
            },
          }),
        ],
        presenceUsers: [
          { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": {
            ...publicationOptions,
            pendingPersonal: {
              result: {
                requestId,
                status: "needs_confirmation",
                publisher: { source: "personal", ...personalAccount },
                message: "Review the original publication before continuing.",
                effect: { kind: "push", status: "dispatched", headCommit: "4".repeat(40) },
              },
              confirmation,
            },
          },
          "sessions.github.confirm": {
            requestId,
            status: "published",
            publisher: { source: "personal", ...personalAccount },
            url: "https://github.com/team/demo/pull/42",
            repository: "team/demo",
            branch: "feature/original",
            headCommit: "4".repeat(40),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway);
      await page.getByRole("button", { name: "Confirm original publication" }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      await page.reload();
      await showPublicationBranch(gateway);
      const details = page.locator(".chat-pr__publication-outcome");
      await expect.poll(() => details.textContent()).toContain("Publish as @alice-tools");
      await expect.poll(() => details.textContent()).toContain("team/demo → main");
      await expect.poll(() => details.textContent()).toContain("alice/demo · feature/original");
      await details.getByText("Original accepted snapshot", { exact: true }).click();
      await expect
        .poll(() => details.locator("details").textContent())
        .toContain(confirmation.workspaceTree);
      await expect
        .poll(() => details.textContent())
        .toContain("remote outcome may still be unknown");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, "06-original-confirmation.png"),
        });
      }
      await page.getByRole("button", { name: "Confirm original publication" }).click();
      const confirmed = await gateway.waitForRequest("sessions.github.confirm");
      expect(confirmed.params).toEqual({
        sessionKey: "agent:main:main",
        requestId,
        requestDigest: confirmation.requestDigest,
        generation: personalGeneration,
        account: personalAccount,
      });
      await expect
        .poll(() => page.getByRole("link", { name: "Open PR" }).getAttribute("href"))
        .toBe("https://github.com/team/demo/pull/42");
      await expect
        .poll(() => page.locator("[data-publication-account]").textContent())
        .toContain("Publish as @alice-tools");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("removes publication mutation controls when the connection becomes read-only", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      presenceUsers: [
        { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await page.getByRole("button", { name: "Publication account" }).click();
    await page.getByRole("combobox", { name: "Publication account" }).selectOption("personal");
    await page.keyboard.press("Escape");
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    await gateway.waitForRequest("sessions.github.publish");
    const previousConnects = (await gateway.getRequests("connect")).length;
    await gateway.setOperatorScopes(["operator.read"]);
    await gateway.closeLatest();
    await gateway.waitForRequest("connect", { after: previousConnects });
    await showPublicationBranch(gateway);
    await expect
      .poll(() => page.getByRole("combobox", { name: "Publication account" }).count())
      .toBe(0);
    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "stale",
      status: "published",
      publisher: { source: "personal", ...personalAccount },
      url: "https://github.com/team/demo/pull/99",
      repository: "team/demo",
      branch: "feature/old",
      headCommit: "a".repeat(40),
    });
    await expect.poll(() => page.getByRole("button", { name: "Publish PR" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Open PR" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
  });
});
