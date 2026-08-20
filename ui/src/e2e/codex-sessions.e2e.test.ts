import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionsCatalogHostEvent } from "../../../packages/gateway-protocol/src/index.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Codex native session catalog",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const catalogGroupingStorageKey = "openclaw:sidebar:sessions:catalog-grouping";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "native-session-discovery",
);

async function expandCodingSection(page: Page, required = false) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  if (required) {
    await toggle.waitFor({ state: "visible" });
  } else {
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector('[data-session-section="work"]') ??
        document.querySelector('[data-session-section^="catalog:"]'),
      ),
    );
    if ((await toggle.count()) === 0) {
      return;
    }
  }
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

suite.define(() => {
  it("omits empty native session catalogs from the sidebar", async () => {
    const page = await suite.browser.newPage();
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

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("sessions.catalog.list");
    expect(await page.locator('[data-session-section="catalog:codex"]').count()).toBe(0);
    expect(await page.locator('[data-session-section="catalog:claude"]').count()).toBe(0);
    await page.close();
  });

  it("separates native catalogs from live Coding rows", async () => {
    const page = await suite.browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1280 },
    });
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: null,
              displayName: "Understanding Startup Phases and Delays",
              hasActiveRun: true,
              key: "agent:main:startup-phases",
              kind: "direct",
              label: "Understanding Startup Phases and Delays",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "running",
              totalTokens: 0,
              updatedAt: Date.now(),
              worktree: {
                id: "startup-phases",
                branch: "startup-phases",
                repoRoot: "/workspace/openclaw",
              },
            },
          ],
          ts: Date.now(),
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true, createSession: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Local Codex",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-startup",
                      name: "Trace startup labels to code paths",
                      cwd: "/workspace/openclaw",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
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
                  sessions: [
                    {
                      threadId: "thread-claude",
                      name: "Review the provider catalog UI",
                      cwd: "/workspace/openclaw",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme-mode", "dark"));
      await expandCodingSection(page, true);
      const sessionGroups = page.locator(".sidebar-recent-sessions");
      const workSection = sessionGroups.locator(':scope > [data-session-section="work"]');
      const liveRows = workSection.locator(":scope > .sidebar-recent-sessions__list");
      const catalog = sessionGroups.locator(':scope > [data-session-section="catalog:codex"]');
      const claudeCatalog = sessionGroups.locator(
        ':scope > [data-session-section="catalog:claude"]',
      );
      await catalog.waitFor({ state: "visible" });
      await claudeCatalog.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          catalog
            .locator(".sidebar-session-catalog-provider-icon")
            .getAttribute("data-provider-icon"),
        )
        .toBe("codex");
      await expect
        .poll(() =>
          claudeCatalog
            .locator(".sidebar-session-catalog-provider-icon")
            .getAttribute("data-provider-icon"),
        )
        .toBe("claude");
      const [liveRowsBox, catalogBox] = await Promise.all([
        liveRows.boundingBox(),
        catalog.boundingBox(),
      ]);
      expect(liveRowsBox).not.toBeNull();
      expect(catalogBox).not.toBeNull();
      // Read the rhythm from the token instead of restating it: the guard is
      // that catalogs are a separate group, not that the gap is any one number.
      const groupGap = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar");
        return sidebar
          ? Number.parseInt(getComputedStyle(sidebar).getPropertyValue("--sidebar-group-gap"), 10)
          : Number.NaN;
      });
      expect(groupGap).toBeGreaterThan(0);
      expect(Math.round(catalogBox!.y - (liveRowsBox!.y + liveRowsBox!.height))).toBe(groupGap);
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await sessionGroups.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "06-coding-catalog-spacing.png"),
        });
      }
    } finally {
      await page.close();
    }
  });

  it("shows a completed host while the aggregate catalog request is still pending", async () => {
    const page = await suite.browser.newPage({ viewport: { height: 900, width: 1280 } });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.catalog.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
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
    const page = await suite.browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 1100, width: 1440 },
    });
    await page.addInitScript((key) => localStorage.removeItem(key), catalogGroupingStorageKey);
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: null,
              displayName: "Research thread",
              hasActiveRun: false,
              key: "agent:main:research",
              kind: "direct",
              label: "Research thread",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "done",
              totalTokens: 0,
              updatedAt: Date.parse("2026-07-29T06:00:00.000Z"),
            },
          ],
          ts: Date.parse("2026-07-29T06:00:00.000Z"),
        },
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
                      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                    },
                    {
                      threadId: "thread-worktree",
                      name: "Worktree fix session",
                      cwd: "/Users/dev/openclaw/.claude/worktrees/fix-1",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                      createdActor: { type: "human", id: "profile-zoe", label: "Zoe" },
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
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "openknot");
        document.documentElement.setAttribute("data-theme-mode", "dark");
      });
      await expandCodingSection(page);
      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.waitFor({ state: "visible" });
      await expect.poll(() => section.locator("[data-session-catalog-host]").count()).toBe(2);
      expect(await section.locator('[data-session-catalog-host="gateway:local"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:build"]').count()).toBe(1);
      expect(await section.getByText("Offline Workstation", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Offline Laptop", { exact: true }).count()).toBe(0);
      const localHost = section.locator('[data-session-catalog-host="gateway:local"]');
      const localHostList = localHost.locator(":scope > .sidebar-session-catalog-host__sessions");
      expect(await localHostList.getAttribute("role")).toBe("list");
      expect(await localHostList.getAttribute("aria-label")).toBe("Local Codex");
      const projectHeads = section.locator("[data-session-catalog-project]");
      await expect.poll(() => projectHeads.count()).toBe(2);
      expect(
        await localHostList
          .locator(":scope > *")
          .evaluateAll((items) => items.map((item) => item.getAttribute("role"))),
      ).toEqual(["listitem", "listitem"]);
      const openclawProject = section.locator(
        '[data-session-catalog-project="/Users/dev/openclaw"]',
      );
      const openclawProjectItem = openclawProject.locator("..");
      const openclawProjectList = openclawProjectItem.locator(":scope > [role=list]");
      expect(await openclawProjectItem.getAttribute("role")).toBe("listitem");
      expect(await openclawProjectList.getAttribute("aria-label")).toBe("Local Codex: openclaw");
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__label").textContent(),
      ).toBe("openclaw");
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__count").textContent(),
      ).toBe("2");
      const projectRows = section.locator(".sidebar-recent-session--catalog-project-child");
      await expect.poll(() => projectRows.count()).toBe(3);
      expect(
        await openclawProjectList
          .locator(":scope > *")
          .evaluateAll((items) => items.map((item) => item.getAttribute("role"))),
      ).toEqual(["listitem", "listitem"]);
      const buildHostList = section.locator(
        '[data-session-catalog-host="node:build"] > .sidebar-session-catalog-host__sessions',
      );
      expect(await buildHostList.getAttribute("aria-label")).toBe("Build Node");
      expect(await buildHostList.locator(":scope > [role=listitem]").count()).toBe(1);
      const threadRows = page.locator(
        '[data-session-section="ungrouped"] .sidebar-recent-session, [data-session-section="catalog:codex"] .sidebar-recent-session--catalog-project-child',
      );
      await expect.poll(() => threadRows.count()).toBe(4);
      expect(await threadRows.locator(".sidebar-recent-session__link[title]").count()).toBe(0);
      const threadRowMetrics = await threadRows.evaluateAll((rows) =>
        rows.map((row) => {
          const link = row.querySelector(".sidebar-recent-session__link");
          const name = row.querySelector(".sidebar-recent-session__name");
          const rowStyle = getComputedStyle(row);
          const linkStyle = link ? getComputedStyle(link) : null;
          const nameStyle = name ? getComputedStyle(name) : null;
          return {
            height: row.getBoundingClientRect().height,
            minHeight: rowStyle.minHeight,
            nameFontSize: nameStyle?.fontSize ?? "",
            paddingBottom: linkStyle?.paddingBottom ?? "",
            paddingTop: linkStyle?.paddingTop ?? "",
            singleLine: row.classList.contains("sidebar-recent-session--single-line"),
          };
        }),
      );
      expect(threadRowMetrics).toHaveLength(4);
      // Gateway threads and native catalog children must stay density-identical.
      // Catalog children never carry preview text, so every subtitle-less row —
      // whichever source it came from — collapses to the same one-line height
      // instead of reserving a phantom second line.
      for (const metric of threadRowMetrics) {
        expect(metric.singleLine).toBe(true);
      }
      const singleLineHeights = new Set(threadRowMetrics.map((metric) => metric.height));
      expect(singleLineHeights.size).toBe(1);
      const [collapsedHeight] = [...singleLineHeights];
      // Collapsed rows sit on the 30px min-height floor; renderer sub-pixels vary.
      expect(collapsedHeight).toBeCloseTo(30, 1);
      for (const metric of threadRowMetrics) {
        expect(metric).toMatchObject({
          minHeight: "30px",
          nameFontSize: "13px",
          paddingBottom: "4px",
          paddingTop: "4px",
        });
      }
      const projectLabelTone = await openclawProject
        .locator(".sidebar-session-catalog-project__label")
        .evaluate((label) => {
          const probe = document.createElement("span");
          document.body.append(probe);
          const resolveColor = (value: string) => {
            probe.style.color = value;
            return getComputedStyle(probe).color;
          };
          const channels = (value: string) => {
            const values =
              value
                .match(/[\d.]+/g)
                ?.slice(0, 3)
                .map(Number) ?? [];
            return value.startsWith("color(srgb") ? values.map((channel) => channel * 255) : values;
          };
          const distance = (left: number[], right: number[]) =>
            Math.hypot(...left.map((channel, index) => channel - (right[index] ?? 0)));
          const labelColor = channels(getComputedStyle(label).color);
          const textColor = channels(resolveColor("var(--text)"));
          const mutedColor = channels(resolveColor("var(--muted)"));
          probe.remove();
          return {
            distanceToMuted: distance(labelColor, mutedColor),
            distanceToText: distance(labelColor, textColor),
          };
        });
      expect(projectLabelTone.distanceToText).toBeLessThan(projectLabelTone.distanceToMuted);
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

      // Header actions are hover-revealed; hover the head so the button
      // regains pointer events before the click, mirroring the Threads menus.
      const catalogHead = section.locator(".sidebar-recent-sessions__head");
      const viewMenuButton = section.locator('[data-session-catalog-view-menu="codex"]');
      await catalogHead.hover();
      await viewMenuButton.click();
      await page
        .getByRole("menuitemradio", { name: "None" })
        .evaluate((element) => (element as HTMLElement).click());
      await expect.poll(() => projectHeads.count()).toBe(0);
      expect(await section.locator("[data-session-key]").count()).toBe(4);
      expect(
        await localHostList
          .locator(":scope > *")
          .evaluateAll((items) => items.map((item) => item.getAttribute("role"))),
      ).toEqual(["listitem", "listitem", "listitem"]);
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

      // Person mode groups adopted (attributed) sessions and leaves native
      // threads without a creator in the flat tail.
      await catalogHead.hover();
      await viewMenuButton.click();
      await page
        .getByRole("menuitemradio", { name: "Person" })
        .evaluate((element) => (element as HTMLElement).click());
      await expect.poll(() => projectHeads.count()).toBe(2);
      expect(
        await localHostList
          .locator(":scope > *")
          .evaluateAll((items) => items.map((item) => item.getAttribute("role"))),
      ).toEqual(["listitem", "listitem", "listitem"]);
      expect(
        await section
          .locator('[data-session-catalog-project="person:profile-ada"]')
          .locator(".sidebar-session-catalog-project__label")
          .textContent(),
      ).toBe("Ada");
      expect(
        await section
          .locator('[data-session-catalog-project="person:profile-zoe"]')
          .locator(".sidebar-session-catalog-project__label")
          .textContent(),
      ).toBe("Zoe");
      expect(
        await page.evaluate((key) => localStorage.getItem(key), catalogGroupingStorageKey),
      ).toBe("person");

      await catalogHead.hover();
      await viewMenuButton.click();
      await page
        .getByRole("menuitemradio", { name: "Project" })
        .evaluate((element) => (element as HTMLElement).click());
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
    const page = await suite.browser.newPage({ viewport: { height: 1100, width: 1440 } });
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
      await page.goto(`${suite.server.baseUrl}chat`);
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

      await page.goto(`${suite.server.baseUrl}settings/automation?section=plugins&advanced=1`);
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
    const page = await suite.browser.newPage();
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
      await page.goto(`${suite.server.baseUrl}chat`);
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
    const page = await suite.browser.newPage();
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
    await page.goto(`${suite.server.baseUrl}chat`);
    await expandCodingSection(page);
    await page.getByText("Release checklist", { exact: true }).click();
    const catalogPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "prepare release" });
    await catalogPane.getByText("prepare release", { exact: true }).waitFor();
    expect(
      (await gateway.getRequests("sessions.catalog.list")).every(
        (request) => (request.params as { agentId?: string } | undefined)?.agentId === "main",
      ),
    ).toBe(true);
    const read = await gateway.waitForRequest("sessions.catalog.read");
    expect(read.params).toMatchObject({
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const composer = catalogPane.locator(".agent-chat__composer-combobox > textarea");
    await composer.fill("continue with the final checks");
    await gateway.setMethodResponse("sessions.list", {
      count: 1,
      defaults: {
        contextTokens: null,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      path: "",
      sessions: [
        {
          contextTokens: null,
          displayName: "Adopted Codex session",
          key: "agent:main:adopted-codex",
          kind: "direct",
          model: "gpt-5.5",
          modelProvider: "openai",
          totalTokens: 0,
          updatedAt: Date.now(),
        },
      ],
      ts: Date.now(),
    });
    await composer.press("Enter");
    const continued = await gateway.waitForRequest("sessions.catalog.continue");
    expect(continued.params).toEqual({
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const sent = await gateway.waitForRequest("chat.send");
    expect(sent.params).toMatchObject({
      sessionKey: "agent:main:adopted-codex",
      message: "continue with the final checks",
    });
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:adopted-codex"));
    await page.close();
  });
});
