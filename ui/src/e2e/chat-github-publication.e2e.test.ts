import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  personalAccount,
  personalGeneration,
  publicationMethods,
  publicationOptions,
  sharedPublisher,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI personal GitHub publication" });

function publicationContextOptions(): Parameters<typeof suite.newBrowserContext>[0] {
  return {
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
    ...(captureUiProof
      ? { recordVideo: { dir: suite.artifactDir, size: { width: 1180, height: 800 } } }
      : {}),
  };
}

async function newPublicationContext() {
  return await suite.newBrowserContext(publicationContextOptions());
}

suite.define(() => {
  it.each(["global", "per-sender"] as const)(
    "carries the selected agent through the complete %s publication flow",
    async (scope) => {
      await suite.withPage(publicationContextOptions(), async ({ page }) => {
        const screenshot = async (name: string) => {
          if (captureUiProof) {
            await page.screenshot({ path: path.join(suite.artifactDir, name), fullPage: true });
          }
        };
        const sessionKey = scope === "global" ? "global" : "agent:research:main";
        const target = { sessionKey, agentId: "research" };
        const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b6";
        const row = createControlUiSessionRow(sessionKey, "Research publication", 1, {
          kind: scope === "global" ? "global" : "direct",
        });
        const result = {
          requestId,
          status: "needs_confirmation",
          publisher: { source: "personal", ...personalAccount },
          message: "Review the selected research session before continuing.",
        };
        const confirmation = {
          requestDigest: "a".repeat(64),
          generation: personalGeneration,
          account: personalAccount,
          repository: "synthetic/publication-demo",
          pushRepository: "alice-tools/publication-demo",
          baseBranch: "main",
          branch: "feature/research",
          sourceHeadCommit: "1".repeat(40),
          sourceIndexTree: "2".repeat(40),
          workspaceTree: "3".repeat(40),
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "ops",
          assistantAgentId: "research",
          assistantName: "Research QA",
          workspace: "/synthetic/research",
          communityInvite: false,
          sessionKey,
          sessionScope: scope === "global" ? "global" : "agent",
          operatorScopes: ["operator.read", "operator.write"],
          featureMethods: publicationMethods,
          sessions: [row],
          presenceUsers: [
            {
              self: true,
              id: "synthetic",
              identity: { type: "profile", id: "synthetic" },
              name: "Synthetic reviewer",
            },
          ],
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "ops", name: "Operations" },
                { id: "research", name: "Research QA" },
              ],
              defaultId: "ops",
              mainKey: "main",
              scope: scope === "global" ? "global" : "agent",
            },
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              agentId: "research",
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [row],
            },
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "sessions.github.options": publicationOptions,
            "sessions.github.publish": result,
            "sessions.github.status": { result, confirmation },
            "sessions.github.confirm": {
              requestId,
              status: "published",
              publisher: result.publisher,
              url: "https://github.com/synthetic/publication-demo/pull/42",
              repository: confirmation.repository,
              branch: confirmation.branch,
              headCommit: "4".repeat(40),
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:research:main"));
        await showPublicationBranch(gateway, confirmation.branch);
        const optionRequest = await gateway.waitForRequest("sessions.github.options");
        expect(optionRequest.params).toEqual(target);
        await page.getByRole("button", { name: "Publication account", exact: true }).click();
        await page.getByRole("combobox", { name: "Publication account" }).selectOption("personal");
        await page.keyboard.press("Escape");
        await screenshot("01-selected-research.png");
        await page.getByRole("button", { name: "Publish PR", exact: true }).click();
        const publication = await gateway.waitForRequest("sessions.github.publish");
        expect(publication.params).toMatchObject({
          ...target,
          selection: {
            source: "personal",
            account: personalAccount,
            generation: personalGeneration,
          },
        });
        const status = await gateway.waitForRequest("sessions.github.status");
        expect(status.params).toEqual({ ...target, requestId });
        const confirm = page.getByRole("button", {
          name: "Confirm original publication",
          exact: true,
        });
        await confirm.waitFor();
        await screenshot("02-research-confirmation.png");
        await confirm.click();
        const confirmed = await gateway.waitForRequest("sessions.github.confirm");
        expect(confirmed.params).toEqual({
          ...target,
          requestId,
          generation: personalGeneration,
          account: personalAccount,
          requestDigest: confirmation.requestDigest,
        });
        const openPr = page.getByRole("link", { name: "Open PR", exact: true });
        await openPr.waitFor();
        expect(await openPr.getAttribute("href")).toBe(
          "https://github.com/synthetic/publication-demo/pull/42",
        );
        expect(new URL(page.url()).pathname).toBe("/chat/research");
        await screenshot("03-research-published.png");
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, "selected-owner-rpc.json"),
            JSON.stringify(
              { scope, target, requests: [optionRequest, publication, status, confirmed] },
              null,
              2,
            ),
          );
        }
      });
    },
  );

  it("shares admitted publication state between already-open same-session split panes", async () => {
    const context = await newPublicationContext();
    const sessionKey = "agent:main:publication";
    await context.addInitScript(
      ({ settingsKey, sessionKey: initialSessionKey }) => {
        localStorage.setItem(
          settingsKey,
          JSON.stringify({
            chatSplitLayout: {
              activePaneId: "p1",
              columns: [
                {
                  id: "c1",
                  panes: [{ id: "p1", sessionKey: initialSessionKey }],
                  paneWeights: [1],
                },
                {
                  id: "c2",
                  panes: [{ id: "p2", sessionKey: initialSessionKey }],
                  paneWeights: [1],
                },
              ],
              columnWeights: [0.5, 0.5],
            },
          }),
        );
      },
      { settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
    );
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      sessionKey,
      sessions: [createControlUiSessionRow(sessionKey, "Publication task", 1)],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await showPublicationBranch(gateway);
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    await expect.poll(() => panes.count()).toBe(2);
    const first = panes.nth(0);
    const second = panes.nth(1);
    await first.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
    await second.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
    await gateway.deferNext("sessions.github.publish");
    await first.getByRole("button", { name: "Publish PR", exact: true }).click();
    const original = await gateway.waitForRequest("sessions.github.publish");
    await first.getByRole("button", { name: "Publishing…", exact: true }).waitFor();
    const pendingProjectionError = await expect
      .poll(() => second.getByRole("button", { name: "Publishing…", exact: true }).count())
      .toBe(1)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect.soft(pendingProjectionError).toBeUndefined();
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, "split-publication-pending.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [first, second]),
      );
    }
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response lost; retry the original request.",
    });
    await first.getByRole("button", { name: "Retry publication", exact: true }).waitFor();
    const retryProjectionError = await expect
      .poll(() => second.getByRole("button", { name: "Retry publication", exact: true }).count())
      .toBe(1)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect.soft(retryProjectionError).toBeUndefined();
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, "split-publication-unknown.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [first, second]),
      );
    }
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
    // Exercise the normal pointer/focus path separately: it may reconcile a
    // stale pane, but it must never create another publication identity.
    await second.click({ position: { x: 20, y: 80 } });
    const retry = second.getByRole("button", { name: "Retry publication", exact: true });
    await retry.waitFor();
    await gateway.deferNext("sessions.github.publish");
    await retry.click();
    const repeated = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(repeated.params).toEqual(original.params);
  });

  it.each([
    ["shared", "navigating away and back", ["agent:main:other"]],
    ["personal", "navigating away and back", ["agent:main:other"]],
    ["shared", "LRU eviction", ["agent:main:other", "agent:main:third", "agent:main:fourth"]],
  ] as const)("keeps the original %s retry after %s", async (source, navigation, via) => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const sessionA = "agent:main:publication";
    const gateway = await installMockGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      sessionKey: sessionA,
      sessions: [
        createControlUiSessionRow(sessionA, "Publication task", 2),
        ...via.map((key, index) =>
          createControlUiSessionRow(key, index === 0 ? "Other task" : `Other task ${index + 1}`, 1),
        ),
      ],
      presenceUsers: [
        {
          self: true,
          id: "synthetic",
          identity: { type: "profile", id: "synthetic" },
          name: "Synthetic reviewer",
        },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
    await showPublicationBranch(gateway);
    const activePane = page.locator(".chat-pane-cache__pane--active");
    await activePane.getByRole("button", { name: "Publication account", exact: true }).click();
    await activePane.getByRole("combobox", { name: "Publication account" }).selectOption(source);
    await page.keyboard.press("Escape");
    await gateway.deferNext("sessions.github.publish");
    await activePane.getByRole("button", { name: "Publish PR", exact: true }).click();
    const first = await gateway.waitForRequest("sessions.github.publish");
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Publication response lost; retry the original request.",
    });
    const retry = activePane.getByRole("button", { name: "Retry publication", exact: true });
    await retry.waitFor();
    const originalPane = await activePane.elementHandle();
    expect(originalPane).not.toBeNull();
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, `${source}-before-navigation.png`),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [retry]),
      );
    }
    const sessionLink = (key: string) =>
      page.locator(
        `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
      );
    for (const next of via) {
      await sessionLink(next).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(next));
    }
    await expect
      .poll(() => originalPane!.evaluate((element) => element.isConnected))
      .toBe(navigation !== "LRU eviction");
    await sessionLink(sessionA).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
    await showPublicationBranch(gateway);
    const publication = activePane.locator('.chat-pr[data-state="branch"]');
    await publication.waitFor();
    await expect
      .poll(() =>
        publication.getByRole("button", { name: /^(Publish PR|Retry publication)$/ }).isEnabled(),
      )
      .toBe(true);
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, `${source}-after-navigation.png`),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [publication]),
      );
      if (navigation === "LRU eviction") {
        await writeFile(
          path.join(suite.artifactDir, "eviction-observation.json"),
          JSON.stringify({
            originalPaneConnected: await originalPane!.evaluate((element) => element.isConnected),
            pathname: new URL(page.url()).pathname,
            publishRequests: await gateway.getRequests("sessions.github.publish"),
            retryButtons: await retry.count(),
            newPublicationButtons: await activePane
              .getByRole("button", { name: "Publish PR", exact: true })
              .count(),
          }),
        );
      }
    }
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
    expect(await retry.count()).toBe(1);
    expect(await activePane.getByRole("combobox", { name: "Publication account" }).count()).toBe(0);
    await gateway.deferNext("sessions.github.publish");
    await retry.click();
    const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(second.params).toEqual(first.params);
  });

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
        await writeFile(
          path.join(suite.artifactDir, `${name}-workspace.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [publish]),
        );
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

  it.each(["shared", "personal"] as const)(
    "refreshes a rejected first %s selection without replaying or publishing automatically",
    async (source) => {
      const context = await newPublicationContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        assistantName: "Publication QA",
        workspace: "/synthetic/publication-qa",
        communityInvite: false,
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: publicationMethods,
        presenceUsers: [
          {
            self: true,
            id: "synthetic",
            identity: { type: "profile", id: "synthetic" },
            name: "Synthetic reviewer",
          },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway, "fix/publisher-recovery");
      await page.getByRole("button", { name: "Publication account", exact: true }).click();
      await page.getByRole("combobox", { name: "Publication account" }).selectOption(source);
      await page.keyboard.press("Escape");
      await gateway.deferNext("sessions.github.publish");
      await page.getByRole("button", { name: "Publish PR", exact: true }).click();
      const first = await gateway.waitForRequest("sessions.github.publish");
      if (!isRecord(first.params)) {
        throw new Error("Publication parameters were not an object");
      }
      expect(first.params).toEqual({
        sessionKey: "agent:main:main",
        agentId: "main",
        idempotencyKey: expect.any(String),
        selection:
          source === "shared"
            ? { source, expected: sharedPublisher }
            : { source, generation: personalGeneration, account: personalAccount },
      });
      await gateway.rejectDeferred("sessions.github.publish", {
        code: "UNAVAILABLE",
        message: "The selected publisher changed. Refresh and review the current account.",
        details: {
          code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
          idempotencyKey: first.params.idempotencyKey,
        },
      });
      const publish = page.getByRole("button", { name: "Publish PR", exact: true });
      await expect.poll(() => publish.isDisabled()).toBe(true);
      const nextAccount = { accountId: 4, login: "publisher-current" };
      const next = {
        ...publicationOptions,
        shared: { ...sharedPublisher, ...nextAccount },
        personal: {
          ...publicationOptions.personal,
          account: nextAccount,
          generation: "e08f9472-c435-4d8d-b970-fb97da80a642",
        },
      };
      await gateway.setMethodResponse("sessions.github.options", next);
      await page.getByRole("button", { name: "Refresh publication", exact: true }).click();
      await expect.poll(() => publish.isEnabled()).toBe(true);
      await page.getByRole("button", { name: "Publication account", exact: true }).click();
      await page.getByRole("combobox", { name: "Publication account" }).selectOption(source);
      await expect
        .poll(() => page.locator("[data-publication-account]").textContent())
        .toContain("publisher-current");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, `${source}-refreshed-selection.png`),
        });
      }
      await page.keyboard.press("Escape");
      await gateway.deferNext("sessions.github.publish");
      await publish.click();
      const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
      expect(second.params).toMatchObject({
        sessionKey: "agent:main:main",
        selection:
          source === "shared"
            ? { source, expected: next.shared }
            : { source, generation: next.personal.generation, account: nextAccount },
      });
      expect(second.params).not.toHaveProperty("idempotencyKey", first.params.idempotencyKey);
      await gateway.resolveDeferred("sessions.github.publish", {
        requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b4",
        status: "published",
        publisher: {
          source: source === "shared" ? sharedPublisher.source : "personal",
          ...nextAccount,
        },
        url: "https://github.com/synthetic/publication-demo/pull/42",
        repository: "synthetic/publication-demo",
        branch: "fix/publisher-recovery",
        headCommit: "a".repeat(40),
      });
      await page.getByRole("link", { name: "Open PR", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(2);
      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(suite.artifactDir, `${source}-explicit-publication.png`),
        });
      }
      const openPr = page.getByRole("link", { name: "Open PR", exact: true });
      expect(await openPr.getAttribute("href")).toBe(
        "https://github.com/synthetic/publication-demo/pull/42",
      );
      const newPublication = page.getByRole("button", {
        name: "Choose a new publication",
        exact: true,
      });
      await expect.poll(() => newPublication.count()).toBe(1);
      await newPublication.click();
      await expect.poll(() => publish.isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(2);
      await page.getByRole("button", { name: "Publication account", exact: true }).click();
      await page.getByRole("combobox", { name: "Publication account" }).selectOption(source);
      await page.keyboard.press("Escape");
      await gateway.deferNext("sessions.github.publish");
      await publish.click();
      const third = await gateway.waitForRequest("sessions.github.publish", { after: 2 });
      expect(third.params).toMatchObject({
        sessionKey: "agent:main:main",
        selection:
          source === "shared"
            ? { source, expected: next.shared }
            : { source, generation: next.personal.generation, account: nextAccount },
      });
      if (!isRecord(second.params)) {
        throw new Error("Publication parameters were not an object");
      }
      expect(third.params).not.toHaveProperty("idempotencyKey", second.params.idempotencyKey);
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
      agentId: "main",
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
      await writeFile(
        path.join(suite.artifactDir, "05-personal-identity-changed.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          page.getByRole("button", { name: "Choose a new publication" }),
        ]),
      );
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
        await writeFile(
          path.join(suite.artifactDir, "06-original-confirmation.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [details]),
        );
      }
      await page.getByRole("button", { name: "Confirm original publication" }).click();
      const confirmed = await gateway.waitForRequest("sessions.github.confirm");
      expect(confirmed.params).toEqual({
        sessionKey: "agent:main:main",
        agentId: "main",
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

  it("acknowledges a completed personal publication with read scope without publishing", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b5";
    const gateway = await installMockGateway(page, {
      assistantName: "Publication QA",
      workspace: "/synthetic/publication-qa",
      communityInvite: false,
      operatorScopes: ["operator.read"],
      featureMethods: publicationMethods,
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
              status: "publishing",
              publisher: { source: "personal", ...personalAccount },
              message: "The original publication is still running.",
            },
            confirmation: null,
          },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await page.getByText("The original publication is still running.", { exact: true }).waitFor();
    // The same profile's writer completes the request; this connection only reads it.
    await gateway.setMethodResponse("sessions.github.status", {
      result: {
        requestId,
        status: "published",
        publisher: { source: "personal", ...personalAccount },
        url: "https://github.com/synthetic/publication-demo/pull/42",
        repository: "synthetic/publication-demo",
        branch: "feature/original",
        headCommit: "a".repeat(40),
      },
      confirmation: null,
    });
    await gateway.setMethodResponse("sessions.github.options", publicationOptions);
    await page.getByRole("button", { name: "Refresh publication", exact: true }).click();
    const statusRequest = await gateway.waitForRequest("sessions.github.status");
    expect(statusRequest.params).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
      requestId,
    });
    const openPr = page.getByRole("link", { name: "Open PR", exact: true });
    await openPr.waitFor();
    expect(await openPr.getAttribute("href")).toBe(
      "https://github.com/synthetic/publication-demo/pull/42",
    );
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    if (captureUiProof) {
      await writeFile(
        path.join(suite.artifactDir, "read-only-completed-publication.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [openPr]),
      );
    }
    const dismiss = page.locator('.chat-pr[data-state="branch"]').getByRole("button", {
      name: "Dismiss",
      exact: true,
    });
    await expect.poll(() => dismiss.count()).toBe(1);
    const previousOptions = (await gateway.getRequests("sessions.github.options")).length;
    await dismiss.click();
    await gateway.waitForRequest("sessions.github.options", { after: previousOptions });
    await openPr.waitFor({ state: "hidden" });
    expect(await page.getByRole("button", { name: "Publish PR", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Confirm original publication" }).count()).toBe(
      0,
    );
    expect(await page.getByRole("combobox", { name: "Publication account" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
  });

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
