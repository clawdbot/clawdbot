import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { expect } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

type SidebarAttentionScopeFlowOptions = {
  artifactDir: string;
  baseUrl: string;
  browser: Browser;
  captureProof: boolean;
};

function visibleDrawerButton(page: Page) {
  return page.locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible").first();
}

async function captureProof(
  params: SidebarAttentionScopeFlowOptions,
  page: Page,
  fileName: string,
) {
  if (!params.captureProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(params.artifactDir, fileName),
  });
}

async function holdProof(page: Page, enabled: boolean) {
  if (enabled) {
    await page.waitForTimeout(600);
  }
}

async function setDarkTheme(page: Page) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.themeMode = "dark";
    root.dataset.themeResolved = "dark";
    root.classList.remove("wa-light");
    root.classList.add("wa-dark");
    root.style.colorScheme = "dark";
  });
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
}

export async function runSidebarAttentionScopeFlow(params: SidebarAttentionScopeFlowOptions) {
  if (params.captureProof) {
    await mkdir(params.artifactDir, { recursive: true });
  }
  const context = await params.browser.newContext({
    locale: "en-US",
    recordVideo: params.captureProof
      ? { dir: params.artifactDir, size: { height: 900, width: 1440 } }
      : undefined,
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  const proofVideo = page.video();
  const failedJob = (id: string, name: string, agentId: string) => ({
    id,
    agentId,
    name,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "test" },
    state: { lastRunStatus: "error", lastError: "Provider request failed" },
  });
  const mainJob = failedJob("main-release-digest", "Main release digest", "main");
  const writerJob = failedJob("writer-release-digest", "Writer release digest", "writer");
  const cronResponse = (jobs: Array<ReturnType<typeof failedJob>>) => ({
    jobs,
    snapshotRevision: `sidebar-agent-scope-${jobs.map((job) => job.id).join("-")}`,
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  });
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
        agents: [
          { id: "main", identity: { name: "Main" }, name: "Main" },
          { id: "writer", identity: { name: "Writer" }, name: "Writer" },
        ],
      },
      "cron.list": {
        cases: [
          { match: { agentId: "main" }, response: cronResponse([mainJob]) },
          { match: { agentId: "writer" }, response: cronResponse([writerJob]) },
          { response: cronResponse([mainJob, writerJob]) },
        ],
      },
      "models.authStatus": { providers: [], ts: 1 },
    },
  });
  const waitForCronScope = async (agentId: string | null) => {
    await expect
      .poll(async () =>
        (await gateway.getRequests("cron.list")).some((request) => {
          const requestParams = request.params as Record<string, unknown> | undefined;
          return agentId === null
            ? Boolean(requestParams && !Object.hasOwn(requestParams, "agentId"))
            : requestParams?.agentId === agentId;
        }),
      )
      .toBe(true);
  };
  const cronScopeRequestCount = async (agentId: string | null) =>
    (await gateway.getRequests("cron.list")).filter((request) => {
      const requestParams = request.params as Record<string, unknown> | undefined;
      return agentId === null
        ? Boolean(requestParams && !Object.hasOwn(requestParams, "agentId"))
        : requestParams?.agentId === agentId;
    }).length;

  try {
    await page.goto(`${params.baseUrl}new`);
    await setDarkTheme(page);
    await waitForCronScope("main");
    await gateway.emitGatewayEvent("exec.approval.requested", {
      id: "approval-global",
      createdAtMs: 1_000,
      expiresAtMs: Date.now() + 60_000,
      request: {
        command: "pnpm test:changed",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    const automationRows = sidebar.locator('[data-attention-kind="cronFailed"]');
    const approvalRow = sidebar.locator('[data-approval-id="approval-global"]');
    const openAutomations = async () => {
      await sidebar.locator(".sidebar-issues-button").click();
      await expect.poll(() => approvalRow.count()).toBe(1);
      await sidebar.getByRole("tab", { name: /Automations/ }).click();
    };

    await openAutomations();
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(0);
    const mainDismiss = automationRows.getByRole("button", {
      name: "Dismiss Main release digest",
    });
    await expect
      .poll(() => mainDismiss.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    await expect
      .poll(() => mainDismiss.evaluate((element) => getComputedStyle(element).pointerEvents))
      .toBe("auto");
    await holdProof(page, params.captureProof);
    await captureProof(params, page, "08-desktop-inbox-main-agent.png");
    await sidebar.locator(".sidebar-issues-button").click();

    await sidebar.getByRole("button", { name: /Switch agent/ }).click();
    await sidebar
      .locator('wa-dropdown.sidebar-agent-menu wa-dropdown-item[value="agent:writer"]')
      .click();
    await waitForCronScope("writer");
    await openAutomations();
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(0);
    await holdProof(page, params.captureProof);
    await captureProof(params, page, "09-desktop-inbox-writer-agent.png");
    await sidebar.locator(".sidebar-issues-button").click();

    await sidebar.getByRole("link", { name: "Automations", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/automations");
    const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
    await pageScope.locator(".agent-select__trigger").click();
    await pageScope
      .locator("wa-dropdown-item[data-agent-option]")
      .filter({ hasText: "All agents" })
      .click();
    await waitForCronScope(null);
    await openAutomations();
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(1);
    await expect
      .poll(() =>
        automationRows
          .filter({ hasText: "Main release digest" })
          .locator(".sidebar-issues-panel__meta-context")
          .textContent(),
      )
      .toBe("Main");
    await expect
      .poll(() =>
        automationRows
          .filter({ hasText: "Writer release digest" })
          .locator(".sidebar-issues-panel__meta-context")
          .textContent(),
      )
      .toBe("Writer");
    await holdProof(page, params.captureProof);
    await captureProof(params, page, "10-desktop-inbox-all-agents.png");

    await automationRows
      .filter({ hasText: "Writer release digest" })
      .getByRole("button", { name: "Dismiss Writer release digest" })
      .click();
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(0);
    await sidebar.locator(".sidebar-issues-button").click();

    const selectPageScope = async (label: string, agentId: string | null) => {
      const previousCount = await cronScopeRequestCount(agentId);
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: label })
        .click();
      await expect.poll(() => cronScopeRequestCount(agentId)).toBeGreaterThan(previousCount);
    };
    await selectPageScope("Main", "main");
    await selectPageScope("All agents", null);
    await openAutomations();
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(0);
    await sidebar.locator(".sidebar-issues-button").click();

    const writerJobNext = failedJob(
      "writer-release-digest-next",
      "Writer release digest",
      "writer",
    );
    await gateway.setMethodResponse("cron.list", {
      cases: [
        { match: { agentId: "main" }, response: cronResponse([mainJob]) },
        { match: { agentId: "writer" }, response: cronResponse([writerJobNext]) },
        { response: cronResponse([mainJob, writerJobNext]) },
      ],
    });
    const previousAllCount = await cronScopeRequestCount(null);
    await gateway.emitGatewayEvent("cron", {});
    await expect.poll(() => cronScopeRequestCount(null)).toBeGreaterThan(previousAllCount);
    await selectPageScope("Writer", "writer");
    await gateway.emitGatewayEvent("update.available", {
      schedule: {
        autoEnabled: false,
        channel: "dev",
        install: { kind: "git", git: { status: "behind", commitsBehind: 246 } },
        target: {
          kind: "git",
          commitsBehind: 246,
          upstreamRef: "origin/main",
          upstreamSha: "9f3c21a0000000000000000000000000000000aa",
        },
      },
      updateAvailable: {
        channel: "dev",
        commitsBehind: 246,
        currentSha: "1111111111111111111111111111111111111111",
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
        upstreamRef: "origin/main",
        upstreamSha: "9f3c21a0000000000000000000000000000000aa",
      },
    });

    const sidebarUpdate = sidebar.locator(
      'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
    );
    await expect.poll(() => sidebar.locator(".sidebar-issues-button__count").count()).toBe(1);
    await sidebar.locator(".sidebar-issues-button").click();
    await expect.poll(() => sidebarUpdate.count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(0);
    await sidebar.locator(".sidebar-issues-button").click();

    await page.setViewportSize({ height: 852, width: 393 });
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--mobile-nav");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const floatingKinds = await page
      .locator(".sidebar-attention--floating [data-attention-kind]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-attention-kind")),
      );
    await visibleDrawerButton(page).click();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-drawer-open");
    await sidebar.locator(".sidebar-issues-button").click();
    await expect.poll(() => sidebarUpdate.isVisible()).toBe(true);
    await expect.poll(() => approvalRow.count()).toBe(1);
    await sidebar.getByRole("tab", { name: /Automations/ }).click();
    await expect.poll(() => automationRows.getByText("Writer release digest").count()).toBe(1);
    await expect.poll(() => automationRows.getByText("Main release digest").count()).toBe(0);
    await holdProof(page, params.captureProof);
    await captureProof(params, page, "11-mobile-inbox-writer-agent.png");

    await sidebar.getByRole("button", { name: "Dismiss shown" }).click();
    await expect.poll(() => automationRows.count()).toBe(0);
    await sidebar.getByRole("tab", { name: /All/ }).click();
    await expect.poll(() => approvalRow.count()).toBe(1);
    await expect.poll(() => sidebarUpdate.isVisible()).toBe(true);
    await holdProof(page, params.captureProof);
    await captureProof(params, page, "12-mobile-inbox-dismissed-alerts.png");

    expect(floatingKinds).toEqual([]);
  } finally {
    await context.close();
    if (proofVideo) {
      await proofVideo.saveAs(path.join(params.artifactDir, "inbox-agent-scope.webm"));
    }
  }
}
