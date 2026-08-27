import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureTopVisibleVirtualRow,
  expectPaintedVirtualRowAnchor,
  startVirtualRowPaintProbe,
  stopVirtualRowPaintProbe,
  type VirtualRowPaintResult,
  waitForPaintedVirtualRowAnchor,
} from "./virtual-row-anchor.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Claude native session catalog",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function resumableClaudeCatalog() {
  return {
    catalogs: [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Mac",
            kind: "local",
            connected: true,
            sessions: [
              {
                threadId: "claude-terminal-session",
                name: "Native Claude terminal",
                status: "stored",
                source: "claude-cli",
                archived: false,
                canContinue: true,
                canArchive: false,
                canOpenTerminal: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

function hostGroupedNativeCatalogs() {
  const catalog = (id: "claude" | "codex", label: string) => ({
    id,
    label,
    capabilities: { continueSession: true, archive: false },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Gateway Mac",
        kind: "gateway",
        connected: true,
        sessions: [
          {
            threadId: `${id}-local`,
            name: `${label} local plan`,
            status: "stored",
            canContinue: true,
            canArchive: false,
          },
        ],
      },
      {
        hostId: "node:build",
        label: "Build Node",
        kind: "node",
        connected: true,
        nodeId: "build",
        sessions: [
          {
            threadId: `${id}-remote`,
            name: `${label} remote review`,
            status: "stored",
            canContinue: false,
            canArchive: false,
          },
        ],
      },
    ],
  });
  return { catalogs: [catalog("claude", "Claude Code"), catalog("codex", "Codex")] };
}

async function catalogHeaderAffordances(header: Locator) {
  return header.evaluate((element) => {
    const toggle = element.querySelector<HTMLElement>(".sidebar-session-group-toggle");
    const providerIcon = element.querySelector<HTMLElement>(
      ".sidebar-session-catalog-provider-icon",
    );
    const chevron = element.querySelector<HTMLElement>(".sidebar-session-group-toggle__icon");
    const grip = element.querySelector<HTMLElement>(".sidebar-session-group-drag-handle");
    const actions = element.querySelector<HTMLElement>(".sidebar-session-group-actions");
    if (!toggle || !providerIcon || !chevron || !grip || !actions) {
      throw new Error("expected complete branded catalog header affordances");
    }
    return {
      actionFocusVisible: actions.matches(":focus-visible"),
      actionFocused: document.activeElement === actions,
      actionsOpacity: getComputedStyle(actions).opacity,
      actionsPointerEvents: getComputedStyle(actions).pointerEvents,
      chevronOpacity: getComputedStyle(chevron).opacity,
      finePointer: matchMedia("(pointer: fine)").matches,
      focusWithin: element.matches(":focus-within"),
      gripOpacity: getComputedStyle(grip).opacity,
      hoverCapable: matchMedia("(hover: hover)").matches,
      hovered: element.matches(":hover"),
      providerOpacity: getComputedStyle(providerIcon).opacity,
      toggleFocusVisible: toggle.matches(":focus-visible"),
      toggleFocused: document.activeElement === toggle,
    };
  });
}

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-session-section="work"]') ??
        document.querySelector('[data-session-section^="catalog:"]'),
      ),
    undefined,
    { timeout: 30_000 },
  );
  if ((await toggle.count()) === 0) {
    return;
  }
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

async function navigateToClaudeCatalog(page: Page) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await expandCodingSection(page);
}

async function triggerClaudeCatalogTerminal(page: Page, options: { force?: boolean } = {}) {
  const row = page.locator('[data-session-key^="catalog:"]').filter({
    hasText: "Native Claude terminal",
  });
  await row.click({ button: "right", force: options.force });
  await page.locator('wa-dropdown-item[value="terminal"]').click({ force: options.force });
}

async function openClaudeCatalogTerminal(page: Page) {
  await navigateToClaudeCatalog(page);
  await triggerClaudeCatalogTerminal(page);
}

suite.define(() => {
  it("shows catalog header affordances only for hover or keyboard-visible focus", async () => {
    await suite.withPage(
      { hasTouch: false, viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.catalog.list",
            "sessions.groups.put",
          ],
          methodResponses: { "sessions.catalog.list": hostGroupedNativeCatalogs() },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await expandCodingSection(page);

        const header = page.locator(
          '[data-session-section="catalog:claude"] .sidebar-recent-sessions__head',
        );
        const toggle = header.locator(".sidebar-session-group-toggle");
        await header.hover();
        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionsOpacity: "1",
            actionsPointerEvents: "auto",
            chevronOpacity: "0.75",
            finePointer: true,
            gripOpacity: "0.55",
            hoverCapable: true,
            hovered: true,
            providerOpacity: "0",
          });

        await toggle.click();
        await page.locator(".chat-main__conversation").hover({ position: { x: 40, y: 40 } });
        await expect
          .poll(() =>
            header.evaluate((element) => {
              const focusedToggle = element.querySelector<HTMLElement>(
                ".sidebar-session-group-toggle",
              );
              return {
                focusWithin: element.matches(":focus-within"),
                hovered: element.matches(":hover"),
                toggleFocusVisible: focusedToggle?.matches(":focus-visible") ?? false,
                toggleFocused: document.activeElement === focusedToggle,
              };
            }),
          )
          .toEqual({
            focusWithin: true,
            hovered: false,
            toggleFocusVisible: false,
            toggleFocused: true,
          });

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await fs.mkdir(artifactDir, { recursive: true });
          await header.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "catalog-header-pointer-away.png"),
          });
        }

        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionsOpacity: "0",
            actionsPointerEvents: "none",
            chevronOpacity: "0",
            focusWithin: true,
            gripOpacity: "0",
            hovered: false,
            providerOpacity: "1",
            toggleFocusVisible: false,
            toggleFocused: true,
          });

        await page.keyboard.press("Tab");
        await expect
          .poll(() => catalogHeaderAffordances(header))
          .toMatchObject({
            actionFocusVisible: true,
            actionFocused: true,
            actionsOpacity: "1",
            actionsPointerEvents: "auto",
            chevronOpacity: "0.75",
            focusWithin: true,
            gripOpacity: "0.55",
            hovered: false,
            providerOpacity: "0",
          });
      },
    );
  });

  it("groups Claude and Codex sessions by Gateway and paired-node host", async () => {
    const page = await suite.browser.newPage({
      hasTouch: true,
      viewport: { width: 1440, height: 900 },
    });
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: { "sessions.catalog.list": hostGroupedNativeCatalogs() },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      for (const catalogId of ["claude", "codex"]) {
        const catalogLabel = catalogId === "claude" ? "Claude Code" : "Codex";
        const section = page.locator(`[data-session-section="catalog:${catalogId}"]`);
        const gatewayHost = section.locator('[data-session-catalog-host="gateway:local"]');
        const buildHost = section.locator('[data-session-catalog-host="node:build"]');
        await gatewayHost.getByText(`${catalogLabel} local plan`, { exact: true }).waitFor();
        await buildHost.getByText("Build Node", { exact: true }).waitFor();
        await buildHost.getByText(`${catalogLabel} remote review`, { exact: true }).waitFor();
        expect(await gatewayHost.locator(".sidebar-session-catalog-host__head").count()).toBe(0);
        expect(await gatewayHost.getByText("Gateway Mac", { exact: true }).count()).toBe(0);
        expect(await gatewayHost.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await buildHost.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await section.getByText(`${catalogLabel} local plan`, { exact: true }).count()).toBe(
          1,
        );
      }

      const touchAffordance = await page
        .locator(
          '[data-session-section="catalog:claude"] .sidebar-session-group-toggle__lead--branded',
        )
        .evaluate((lead) => {
          const providerIcon = lead.querySelector<HTMLElement>(
            ".sidebar-session-catalog-provider-icon",
          );
          const chevron = lead.querySelector<HTMLElement>(".sidebar-session-group-toggle__icon");
          if (!providerIcon || !chevron) {
            throw new Error("expected branded catalog provider icon and chevron");
          }
          return {
            coarsePointer: matchMedia("(pointer: coarse)").matches,
            noHover: matchMedia("(hover: none)").matches,
            providerOpacity: getComputedStyle(providerIcon).opacity,
            chevronOpacity: getComputedStyle(chevron).opacity,
          };
        });
      expect(touchAffordance).toEqual({
        coarsePointer: true,
        noHover: true,
        providerOpacity: "0",
        chevronOpacity: "0.75",
      });

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDir, "native-session-host-groups.png"),
          fullPage: true,
        });
      }
    } finally {
      await page.close();
    }
  });

  it("shows catalog connection progress until the first terminal output", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["terminal.open"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.catalog.list",
          "sessions.catalog.read",
          "terminal.open",
        ],
        methodResponses: {
          "sessions.catalog.list": resumableClaudeCatalog(),
          "sessions.catalog.read": {
            hostId: "gateway:local",
            threadId: "claude-terminal-session",
            items: [{ type: "userMessage", text: "Continue the native session" }],
          },
          "terminal.list": { sessions: [] },
        },
        terminalEnabled: true,
      });

      await openClaudeCatalogTerminal(page);
      await expect
        .poll(async () =>
          (await gateway.getRequests("terminal.open")).map((request) => request.params),
        )
        .toContainEqual(
          expect.objectContaining({
            catalog: {
              catalogId: "claude",
              hostId: "gateway:local",
              threadId: "claude-terminal-session",
            },
          }),
        );
      const connecting = page.getByRole("status").filter({ hasText: "Connecting to session" });
      await connecting.waitFor();
      expect(await page.locator(".tabstrip-tab.is-connecting").count()).toBe(1);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, "claude-terminal-connecting.png") });
      }

      await gateway.resolveDeferred("terminal.open", {
        agentId: "main",
        confined: false,
        cwd: "/workspace",
        sessionId: "claude-terminal-e2e",
        shell: "/bin/zsh",
        title: "claude --resume claude-termi…",
      });
      await expect.poll(() => connecting.count()).toBe(1);
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "claude-terminal-e2e",
        seq: 17,
        data: "Claude Code ready\r\n",
      });
      await expect.poll(() => connecting.count()).toBe(0);
      expect(await page.locator(".tabstrip-tab.is-live").count()).toBe(1);
    });
  });

  it("closes a catalog terminal that produces no output before the deadline", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.catalog.list",
          "sessions.catalog.read",
          "terminal.open",
        ],
        methodResponses: {
          "sessions.catalog.list": resumableClaudeCatalog(),
          "sessions.catalog.read": {
            hostId: "gateway:local",
            threadId: "claude-terminal-session",
            items: [],
          },
          "terminal.list": { sessions: [] },
          "terminal.open": {
            agentId: "main",
            confined: false,
            cwd: "/workspace",
            sessionId: "claude-terminal-timeout",
            shell: "/bin/zsh",
            title: "claude --resume claude-termi…",
          },
        },
        terminalEnabled: true,
      });

      await navigateToClaudeCatalog(page);
      await page.clock.install();
      await triggerClaudeCatalogTerminal(page, { force: true });
      await expect
        .poll(async () =>
          (await gateway.getRequests("terminal.open")).map((request) => request.params),
        )
        .toContainEqual(
          expect.objectContaining({ catalog: expect.objectContaining({ catalogId: "claude" }) }),
        );
      await page.getByRole("status").filter({ hasText: "Connecting to session" }).waitFor();
      await page
        .locator("openclaw-terminal-panel .tabstrip-tab", {
          hasText: "claude --resume claude-termi…",
        })
        .waitFor();
      const resize = await gateway.waitForRequest("terminal.resize");
      expect(resize.params).toEqual(
        expect.objectContaining({ sessionId: "claude-terminal-timeout" }),
      );
      await page.clock.fastForward(30_001);
      await page.clock.runFor(100);

      await page.getByText("Session did not connect within 30 seconds.", { exact: true }).waitFor();
      const close = await gateway.waitForRequest("terminal.close");
      expect(close.params).toEqual({ sessionId: "claude-terminal-timeout" });
      expect(await page.locator("openclaw-terminal-panel .tabstrip-tab").count()).toBe(0);
    });
  });

  it("auto-loads older chat without moving the viewport and disables paired-node continuation", async () => {
    const page = await suite.browser.newPage();
    await page.clock.install();
    const catalogResponse = (threadId: string, name: string, nextCursor?: string) => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: { continueSession: true, archive: false },
          hosts: [
            {
              hostId: "node:devbox",
              label: "Dev Box",
              kind: "node",
              connected: true,
              nodeId: "devbox",
              sessions: [
                {
                  threadId,
                  name,
                  status: "stored",
                  source: "claude-cli",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
              ...(nextCursor ? { nextCursor } : {}),
            },
          ],
        },
      ],
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          cases: [
            {
              match: {
                agentId: "main",
                catalogId: "claude",
                cursors: { "node:devbox": "catalog-page-2" },
              },
              response: catalogResponse("older-remote-thread", "Older remote review"),
            },
            {
              match: {},
              response: catalogResponse(
                "remote-thread",
                "Remote architecture review",
                "catalog-page-2",
              ),
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { cursor: "older" },
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: [{ id: "a0", type: "agentMessage", text: "older question" }],
              },
            },
            {
              match: {},
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: Array.from({ length: 40 }, (_, index) => ({
                  id: `a${index + 1}`,
                  type: index % 2 === 0 ? "agentMessage" : "userMessage",
                  text:
                    index === 0
                      ? "newer answer"
                      : `recent transcript message ${index + 1} with enough text to fill the pane`,
                })),
                nextCursor: "older",
              },
            },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await expandCodingSection(page);
    const catalog = page.locator('[data-session-section="catalog:claude"]');
    await page.locator('[data-session-catalog-load-more="claude"]').click();
    await catalog.getByRole("link", { name: "Older remote review", exact: true }).waitFor();
    expect((await gateway.getRequests("sessions.catalog.list")).at(-1)?.params).toEqual({
      agentId: "main",
      catalogId: "claude",
      cursors: { "node:devbox": "catalog-page-2" },
    });
    const catalogRequestCount = (await gateway.getRequests("sessions.catalog.list")).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(50);
    expect((await gateway.getRequests("sessions.catalog.list")).length).toBe(catalogRequestCount);
    await page.clock.fastForward(30_000);
    await page.clock.runFor(100);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
      .toBeGreaterThanOrEqual(catalogRequestCount + 1);
    await catalog.getByRole("link", { name: "Older remote review", exact: true }).waitFor();
    const remote = catalog.getByRole("link", { name: /^Remote architecture review$/ });
    await remote.hover();
    await page.locator(".session-progress-hovercard").waitFor();
    await remote.click();
    await expect.poll(() => page.getByText("newer answer", { exact: true }).count()).toBe(1);
    const catalogPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const thread = catalogPane.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const initialReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await gateway.deferNext("sessions.catalog.read");
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.clock.runFor(100);
    await catalogPane
      .locator('.chat-virtual-row:not([data-virtual-row-key="history"])')
      .first()
      .waitFor();
    await expect
      .poll(() => gateway.getRequests("sessions.catalog.read").then((requests) => requests.length))
      .toBe(initialReadCount + 1);
    await catalogPane.locator(".chat-history-loading").waitFor();
    const showEarlier = catalogPane.getByRole("button", { name: "Show earlier" });
    await showEarlier.waitFor();
    expect(await showEarlier.getAttribute("aria-busy")).toBe("true");
    const anchor = await captureTopVisibleVirtualRow(thread);
    await startVirtualRowPaintProbe(thread, anchor);
    let paintResult: VirtualRowPaintResult;
    try {
      await gateway.resolveDeferred("sessions.catalog.read");
      await expect
        .poll(() =>
          catalogPane.evaluate(
            (element) =>
              (element as HTMLElement & { catalogMessages: unknown[] }).catalogMessages.length,
          ),
        )
        .toBe(41);
      await page.clock.runFor(100);
      await waitForPaintedVirtualRowAnchor(thread, anchor);
    } finally {
      paintResult = await stopVirtualRowPaintProbe(thread);
    }
    expectPaintedVirtualRowAnchor(anchor, paintResult);
    expect(
      await catalogPane.locator(".agent-chat__composer-combobox > textarea").isDisabled(),
    ).toBe(true);
    await expect
      .poll(() => page.getByText("This session is on a paired device and is view-only.").count())
      .toBe(1);
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const expectCenteredLayout = async (screenshotName: string) => {
      const [workbenchBox, threadBox, composerBox] = await Promise.all([
        catalogPane.locator(".chat-workbench").boundingBox(),
        catalogPane.locator(".chat-thread-inner").boundingBox(),
        catalogPane.locator(".agent-chat__composer-shell").boundingBox(),
      ]);
      expect(workbenchBox).not.toBeNull();
      expect(threadBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      const workbenchCenter = workbenchBox!.x + workbenchBox!.width / 2;
      expect(Math.abs(threadBox!.x + threadBox!.width / 2 - workbenchCenter)).toBeLessThanOrEqual(
        1,
      );
      expect(
        Math.abs(composerBox!.x + composerBox!.width / 2 - workbenchCenter),
      ).toBeLessThanOrEqual(1);
      if (artifactDir) {
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(artifactDir, screenshotName),
          fullPage: true,
        });
      }
    };
    await expectCenteredLayout("claude-external-session-centered-1280.png");
    await page.setViewportSize({ width: 1600, height: 900 });
    await expectCenteredLayout("claude-external-session-centered-1600.png");
    expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
      catalogId: "claude",
      cursor: "older",
    });
    const exhaustedReadCount = (await gateway.getRequests("sessions.catalog.read")).length;
    await thread.hover();
    await page.mouse.wheel(0, -10_000);
    await page.clock.runFor(100);
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
    await expect.poll(() => page.getByText("older question", { exact: true }).count()).toBe(1);
    await page.clock.runFor(500);
    expect(await catalogPane.locator(".chat-history-loading").count()).toBe(0);
    expect(await catalogPane.getByRole("button", { name: "Show earlier" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(exhaustedReadCount);
    await page.close();
  });

  it("auto-pages an underfilled native transcript until it becomes scrollable", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const viewport = { width: 1280, height: 900 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const historyMessage = (seq: number, role: "assistant" | "user", text: string) => ({
      __openclaw: { seq },
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      role,
      timestamp: 1_800_000_000_000 + seq,
    });
    const recent = [
      historyMessage(21, "user", "Recent question"),
      historyMessage(22, "assistant", "Recent answer"),
    ];
    // Consecutive assistant records collapse into one rendered group, so this
    // page advances the raw offset without filling the real transcript viewport.
    const firstOlderPage = Array.from({ length: 4 }, (_, index) =>
      historyMessage(index + 17, "assistant", `Short older answer ${index + 17}`),
    );
    const secondOlderPage = Array.from({ length: 16 }, (_, index) => {
      const seq = index + 1;
      const role = seq % 2 === 0 ? "assistant" : "user";
      return historyMessage(
        seq,
        role,
        `Scrollable older ${role} message ${seq}\n${"Transcript detail line\n".repeat(3)}`,
      );
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.history"],
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages: recent,
          hasMore: true,
          nextOffset: 2,
          totalMessages: 30,
          sessionId: "native-underfill-pagination",
          thinkingLevel: null,
        },
        "chat.history": {
          cases: [
            {
              match: { offset: 2 },
              response: {
                messages: firstOlderPage,
                hasMore: true,
                nextOffset: 6,
                totalMessages: 30,
                sessionId: "native-underfill-pagination",
                thinkingLevel: null,
              },
            },
            {
              match: { offset: 6 },
              response: {
                messages: secondOlderPage,
                hasMore: true,
                nextOffset: 22,
                totalMessages: 30,
                sessionId: "native-underfill-pagination",
                thinkingLevel: null,
              },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const thread = pane.locator(".chat-thread");
      await page.getByText("Recent answer", { exact: true }).waitFor();
      await expect
        .poll(async () =>
          (await gateway.getRequests("chat.history")).map(
            (request) => (request.params as { offset?: number } | undefined)?.offset,
          ),
        )
        .toEqual([2]);
      await pane.locator(".chat-history-loading").waitFor();
      expect(await thread.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "00-native-history-initial-underfill-loading.png"),
          fullPage: true,
        });
      }

      await gateway.deferNext("chat.history", { offset: 6 });
      await gateway.resolveDeferred("chat.history");
      await expect
        .poll(async () =>
          (await gateway.getRequests("chat.history")).map(
            (request) => (request.params as { offset?: number } | undefined)?.offset,
          ),
        )
        .toEqual([2, 6]);
      await pane.locator(".chat-history-loading").waitFor();
      expect(await thread.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "01-native-history-continued-auto-load.png"),
          fullPage: true,
        });
      }

      await gateway.resolveDeferred("chat.history");
      await expect
        .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      await expect.poll(() => pane.locator(".chat-history-loading").count()).toBe(0);
      expect(await pane.locator(".chat-history-sentinel").count()).toBe(1);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "02-native-history-final-scrollable.png"),
          fullPage: true,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(
        (await gateway.getRequests("chat.history")).map(
          (request) => (request.params as { offset?: number } | undefined)?.offset,
        ),
      ).toEqual([2, 6]);
    } finally {
      await suite.closeBrowserContext(context);
      if (artifactDir && proofVideo) {
        await proofVideo.saveAs(path.join(artifactDir, "native-history-auto-pagination.webm"));
      }
    }
  });

  it("shows loaded native history before fetching and revealing an earlier page", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 800 } });
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const historyMessage = (seq: number, prefix: string) => ({
      __openclaw: { seq },
      content: [
        {
          type: "text",
          text: `${prefix} ${seq}\n${"transcript detail line\n".repeat(3)}`,
        },
      ],
      role: seq % 2 === 0 ? "assistant" : "user",
      timestamp: Date.now() + seq,
    });
    const recent = Array.from({ length: 100 }, (_, index) =>
      historyMessage(index + 41, "recent native message"),
    );
    const older = Array.from({ length: 40 }, (_, index) =>
      historyMessage(index + 1, "older native message"),
    );
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages: recent,
          hasMore: true,
          nextOffset: 100,
          totalMessages: 140,
          sessionId: "native-scrollback",
          thinkingLevel: null,
        },
        "chat.history": {
          cases: [
            {
              match: { offset: 100 },
              response: {
                messages: older,
                hasMore: false,
                totalMessages: 140,
                sessionId: "native-scrollback",
                thinkingLevel: null,
              },
            },
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(/^recent native message 140\n/).waitFor();
    const thread = page.locator(".chat-thread");
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 100))
      .toBe(true);
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    const showEarlier = page.getByRole("button", { name: "Show earlier" });
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "00-native-history-available.png"),
        fullPage: true,
      });
    }
    const initialRequestCount = (await gateway.getRequests("chat.history")).length;
    const tailAnchor = await captureTopVisibleVirtualRow(thread);
    const initialScrollTop = await thread.evaluate((element) => element.scrollTop);
    await showEarlier.click();
    await expect
      .poll(() => thread.evaluate((element) => element.scrollTop))
      .toBeLessThan(initialScrollTop);
    const earlierAnchor = await captureTopVisibleVirtualRow(thread);
    expect(earlierAnchor.index).toBeLessThan(tailAnchor.index);
    expect(await gateway.getRequests("chat.history")).toHaveLength(initialRequestCount);
    await gateway.deferNext("chat.history");
    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.parentElement?.querySelector<HTMLButtonElement>(".chat-history-available")?.click();
    });
    // Pin each wait past the earlier chat.history traffic so a slow runner
    // can't return a stale load-time or prior-page request.
    await gateway.waitForRequest("chat.history", { after: initialRequestCount });
    await page.locator(".chat-history-loading").waitFor();
    expect(await showEarlier.getAttribute("aria-busy")).toBe("true");
    if (artifactDir) {
      await page.screenshot({
        path: path.join(artifactDir, "01-native-history-loading.png"),
        fullPage: true,
      });
    }
    await gateway.rejectDeferred("chat.history", {
      code: "UNAVAILABLE",
      message: "history unavailable",
      retryable: true,
    });
    await expect.poll(() => page.locator(".chat-history-loading").count()).toBe(0);
    expect(await showEarlier.getAttribute("aria-busy")).toBe("false");
    const failedRequestCount = (await gateway.getRequests("chat.history")).length;
    await gateway.deferNext("chat.history");
    await showEarlier.click();
    await gateway.waitForRequest("chat.history", { after: failedRequestCount });
    await page.locator(".chat-history-loading").waitFor();
    expect(await gateway.getRequests("chat.history")).toHaveLength(failedRequestCount + 1);
    await gateway.resolveDeferred("chat.history", {
      messages: older,
      hasMore: true,
      nextOffset: 140,
      totalMessages: 180,
      sessionId: "native-scrollback",
      thinkingLevel: null,
    });
    await expect
      .poll(() =>
        page
          .locator("openclaw-chat-pane")
          .evaluate(
            (element) =>
              (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                .length,
          ),
      )
      .toBe(140);
    const firstOlderMessage = page.getByText(/^older native message 1\n/);
    await firstOlderMessage.waitFor();
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
    if (artifactDir) {
      await page.screenshot({
        path: path.join(artifactDir, "02-native-history-prepended-visible.png"),
        fullPage: true,
      });
    }
    expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
      limit: 100,
      offset: 100,
    });
    const firstPageRequestCount = (await gateway.getRequests("chat.history")).length;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await gateway.getRequests("chat.history")).toHaveLength(firstPageRequestCount);
    await gateway.deferNext("chat.history");
    await showEarlier.click();
    await gateway.waitForRequest("chat.history", { after: firstPageRequestCount });
    expect((await gateway.getRequests("chat.history")).at(-1)?.params).toMatchObject({
      limit: 100,
      offset: 140,
    });
    await gateway.resolveDeferred("chat.history", {
      messages: [],
      hasMore: false,
      totalMessages: 180,
      sessionId: "native-scrollback",
      thinkingLevel: null,
    });
    await expect.poll(() => page.locator(".chat-history-sentinel").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Show earlier" }).count()).toBe(0);
    expect(await page.locator(".chat-history-loading").count()).toBe(0);
    expect(await gateway.getRequests("chat.history")).toHaveLength(firstPageRequestCount + 1);
    await page.close();
  });
});
