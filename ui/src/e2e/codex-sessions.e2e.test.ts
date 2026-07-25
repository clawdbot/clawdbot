import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionsCatalogHostEvent } from "../../../packages/gateway-protocol/src/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const catalogGroupingStorageKey = "openclaw:sidebar:sessions:catalog-grouping";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "native-session-discovery",
);

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

suite("Codex native session catalog", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("omits empty native session catalogs from the sidebar", async () => {
    const page = await browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:codex",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [],
                },
              ],
            },
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: true, archive: false },
              hosts: [
                {
                  hostId: "gateway:claude",
                  label: "Local Claude",
                  kind: "gateway",
                  connected: true,
                  sessions: [],
                },
              ],
            },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}chat`);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
      .toBeGreaterThan(0);
    expect(await page.locator('[data-session-section="catalog:codex"]').count()).toBe(0);
    expect(await page.locator('[data-session-section="catalog:claude"]').count()).toBe(0);
    await page.close();
  });

  it("shows a completed host while the aggregate catalog request is still pending", async () => {
    const page = await browser.newPage({ viewport: { height: 900, width: 1280 } });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.catalog.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const request = await gateway.waitForRequest("sessions.catalog.list");
      const progressId = (request.params as { progressId?: string })?.progressId;
      expect(progressId).toEqual(expect.any(String));
      if (!progressId) {
        throw new Error("catalog request did not opt in to progressive host events");
      }
      await gateway.emitGatewayEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: {
          id: "codex",
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: [
            {
              hostId: "node:fast",
              label: "Fast Mac",
              kind: "node",
              connected: true,
              nodeId: "fast",
              sessions: [
                {
                  threadId: "thread-fast",
                  name: "Progressive node result",
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: false,
                },
              ],
            },
          ],
        },
      } satisfies SessionsCatalogHostEvent);

      await expandCodingSection(page);
      await page.getByText("Progressive node result", { exact: true }).waitFor();
      expect((await gateway.getRequests("sessions.catalog.list")).length).toBe(1);
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "05-progressive-host-result.png"),
        });
      }

      await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
    } finally {
      await page.close();
    }
  });

  it("groups sessions by host and hides empty offline nodes", async () => {
    const page = await browser.newPage({ viewport: { height: 1100, width: 1440 } });
    await page.addInitScript((key) => localStorage.removeItem(key), catalogGroupingStorageKey);
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-local",
                      name: "Local planning session",
                      cwd: "/Users/dev/openclaw",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                    {
                      threadId: "thread-worktree",
                      name: "Worktree fix session",
                      cwd: "/Users/dev/openclaw/.claude/worktrees/fix-1",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                    {
                      threadId: "thread-other",
                      name: "Other project session",
                      cwd: "/Users/dev/other",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
                {
                  hostId: "node:offline-a",
                  label: "Offline Workstation",
                  kind: "node",
                  connected: false,
                  sessions: [],
                  error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
                },
                {
                  hostId: "node:build",
                  label: "Build Node",
                  kind: "node",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-remote",
                      name: "Remote review session",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
                {
                  hostId: "node:offline-b",
                  label: "Offline Laptop",
                  kind: "node",
                  connected: false,
                  sessions: [],
                  error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expandCodingSection(page);
      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.waitFor({ state: "visible" });
      await expect.poll(() => section.locator("[data-session-catalog-host]").count()).toBe(2);
      expect(await section.locator('[data-session-catalog-host="gateway:local"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:build"]').count()).toBe(1);
      expect(await section.getByText("Offline Workstation", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Offline Laptop", { exact: true }).count()).toBe(0);
      const projectHeads = section.locator("[data-session-catalog-project]");
      await expect.poll(() => projectHeads.count()).toBe(2);
      const openclawProject = section.locator(
        '[data-session-catalog-project="/Users/dev/openclaw"]',
      );
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__label").textContent(),
      ).toBe("openclaw");
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__count").textContent(),
      ).toBe("2");
      expect(
        await section
          .locator('[data-session-catalog-project="/Users/dev/other"]')
          .locator(".sidebar-session-catalog-project__label")
          .textContent(),
      ).toBe("other");
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(1);
      const toggle = section.locator(".sidebar-session-group-toggle");
      expect(await toggle.getAttribute("title")).toBeNull();
      // Counts only render while a section is collapsed.
      expect(await section.locator(".sidebar-session-group-count").count()).toBe(0);

      const groupingToggle = section.locator('[data-session-catalog-grouping-toggle="codex"]');
      await groupingToggle.click();
      await expect.poll(() => projectHeads.count()).toBe(0);
      expect(await section.locator("[data-session-key]").count()).toBe(4);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), catalogGroupingStorageKey),
      ).toBe("none");
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await section.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "04-flat-session-hosts.png"),
        });
      }

      await groupingToggle.click();
      await expect.poll(() => projectHeads.count()).toBe(2);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), catalogGroupingStorageKey),
      ).toBe("project");

      await openclawProject.click();
      await expect.poll(() => openclawProject.getAttribute("aria-expanded")).toBe("false");
      expect(await section.getByText("Local planning session", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Other project session", { exact: true }).count()).toBe(1);
      expect(await openclawProject.count()).toBe(1);
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__count").textContent(),
      ).toBe("2");
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
          collapsedSessionSectionsStorageKey,
        ),
      ).toContain("catalog-project:codex:gateway:local:/Users/dev/openclaw");

      await openclawProject.click();
      await expect.poll(() => openclawProject.getAttribute("aria-expanded")).toBe("true");
      expect(await section.getByText("Local planning session", { exact: true }).count()).toBe(1);
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(1);
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
          collapsedSessionSectionsStorageKey,
        ),
      ).not.toContain("catalog-project:codex:gateway:local:/Users/dev/openclaw");

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await section.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "03-content-bearing-session-hosts.png"),
        });
      }
    } finally {
      await page.close();
    }
  });

  it("explains node-list failures and exposes independent discovery settings", async () => {
    const page = await browser.newPage({ viewport: { height: 1100, width: 1440 } });
    await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.schema",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "config.get": {
          config: {
            plugins: {
              entries: {
                anthropic: { config: { sessionCatalog: { enabled: false } } },
                codex: { config: { sessionCatalog: { enabled: true } } },
              },
            },
          },
          hash: "native-session-discovery-e2e",
        },
        "config.schema": {
          schema: {
            type: "object",
            properties: {
              plugins: {
                type: "object",
                properties: {
                  entries: {
                    type: "object",
                    properties: {
                      anthropic: {
                        type: "object",
                        properties: {
                          config: {
                            type: "object",
                            properties: {
                              sessionCatalog: {
                                type: "object",
                                properties: { enabled: { type: "boolean", default: true } },
                              },
                            },
                          },
                        },
                      },
                      codex: {
                        type: "object",
                        properties: {
                          config: {
                            type: "object",
                            properties: {
                              sessionCatalog: {
                                type: "object",
                                properties: { enabled: { type: "boolean", default: true } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          uiHints: {
            "plugins.entries.anthropic.config.sessionCatalog.enabled": {
              label: "Discover Claude Code Sessions",
              help: "List native Claude Code sessions in the sidebar from this Gateway and eligible paired nodes.",
            },
            "plugins.entries.codex.config.sessionCatalog.enabled": {
              label: "Discover Codex Sessions",
              help: "List native Codex sessions in the sidebar from this Gateway and eligible paired nodes.",
            },
          },
          version: "e2e",
          generatedAt: "2026-07-14T00:00:00.000Z",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "node:registry",
                  label: "Paired nodes",
                  kind: "node",
                  connected: false,
                  sessions: [],
                  error: {
                    code: "NODE_LIST_FAILED",
                    message: "Paired nodes could not be listed: pairing database is locked",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expandCodingSection(page);
      const warning = page.locator(
        '[data-session-section="catalog:codex"] .sidebar-session-group-toggle',
      );
      await warning.waitFor({ state: "visible" });
      await expect.poll(() => warning.getAttribute("title")).toContain("[NODE_LIST_FAILED]");
      await expect
        .poll(() => warning.getAttribute("title"))
        .toContain("pairing database is locked");
      await expect
        .poll(() => warning.getAttribute("title"))
        .toContain("Settings > Automation > Plugins");
      expect(await page.locator('[data-session-catalog-host="node:registry"]').count()).toBe(0);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "01-actionable-sidebar-error.png"),
        });
      }

      await page.goto(`${server.baseUrl}settings/automation?section=plugins`);
      const expandPluginSetting = async (pluginLabel: string) => {
        const pluginGroup = page
          .getByText(pluginLabel, { exact: true })
          .locator("xpath=ancestor::details[1]");
        await pluginGroup.locator(":scope > summary").click();
        const configGroup = pluginGroup
          .getByText("Config", { exact: true })
          .locator("xpath=ancestor::details[1]");
        await configGroup.locator(":scope > summary").click();
        const catalogGroup = configGroup
          .getByText("Session Catalog", { exact: true })
          .locator("xpath=ancestor::details[1]");
        await catalogGroup.locator(":scope > summary").click();
      };
      await expandPluginSetting("Anthropic");
      await expandPluginSetting("Codex");
      const codexSetting = page.locator(".settings-row", { hasText: "Discover Codex Sessions" });
      const claudeSetting = page.locator(".settings-row", {
        hasText: "Discover Claude Code Sessions",
      });
      await codexSetting.waitFor({ state: "visible" });
      await claudeSetting.waitFor({ state: "visible" });
      expect(await codexSetting.getByText("eligible paired nodes.", { exact: false }).count()).toBe(
        1,
      );
      expect(
        await claudeSetting.getByText("eligible paired nodes.", { exact: false }).count(),
      ).toBe(1);
      expect(
        await codexSetting
          .locator("wa-switch")
          .evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
      ).toBe(true);
      expect(
        await claudeSetting
          .locator("wa-switch")
          .evaluate((element) => (element as HTMLElement & { checked: boolean }).checked),
      ).toBe(false);

      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(uiProofArtifactDir, "02-independent-settings-toggles.png"),
        });
      }
    } finally {
      await page.close();
    }
  });

  it("shows a catalog Load More rejection without losing the retry cursor", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:codex",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-1",
                      name: "Newest session",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                  nextCursor: "page-2",
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await expandCodingSection(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(1);
      const loadMore = page.locator('[data-session-catalog-load-more="codex"]');
      await loadMore.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.catalog.list");
      await loadMore.click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "Second catalog page unavailable",
      });

      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.locator('[data-session-catalog-error="codex"]').waitFor({ state: "visible" });
      await expect
        .poll(() => section.locator(".sidebar-session-group-toggle").getAttribute("aria-label"))
        .toContain("Second catalog page unavailable");
      await expect.poll(() => loadMore.getAttribute("aria-busy")).toBe("false");
      expect(await loadMore.isEnabled()).toBe(true);
      expect(await page.getByText("Newest session", { exact: true }).count()).toBe(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("adopts from the native chat composer, navigates, and auto-sends", async () => {
    const page = await browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-1",
                      name: "Release checklist",
                      status: "idle",
                      source: "cli",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "thread-1",
          items: [{ id: "u1", type: "userMessage", text: "prepare release" }],
        },
        "sessions.catalog.continue": { sessionKey: "agent:main:adopted-codex" },
        "chat.send": { runId: "run-adopted", status: "started" },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    await expandCodingSection(page);
    await page.getByText("Release checklist", { exact: true }).click();
    await expect.poll(() => page.getByText("prepare release", { exact: true }).count()).toBe(1);
    const composer = page.locator(".agent-chat__composer-combobox > textarea");
    await composer.fill("continue with the final checks");
    await composer.press("Enter");
    const continued = await gateway.waitForRequest("sessions.catalog.continue");
    expect(continued.params).toEqual({
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const sent = await gateway.waitForRequest("chat.send");
    expect(sent.params).toMatchObject({
      sessionKey: "agent:main:adopted-codex",
      message: "continue with the final checks",
    });
    await expect.poll(() => page.url()).toMatch(/session=agent%3Amain%3Aadopted-codex/);
    await page.close();
  });
});
