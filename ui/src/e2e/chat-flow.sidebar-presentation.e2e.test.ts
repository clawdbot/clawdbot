import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  installMockGateway,
  pauseVirtualClock,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const terminalMetadataProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "remote-session-sidebar-metadata",
);
const sessionSecondRowProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-status-second-row-implementation",
);
const subtitleStabilityProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "sidebar-subtitle-stability",
);

suite.define(() => {
  it("keeps a running subtitle and row height stable when its session is opened", async () => {
    if (captureUiProofEnabled) {
      await mkdir(subtitleStabilityProofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: subtitleStabilityProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const firstKey = "agent:main:session-a";
    const secondKey = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: firstKey,
            kind: "direct",
            label: "First running session",
            updatedAt: 2,
            activeRunIds: ["run-first"],
            hasActiveRun: true,
            status: "running",
          },
          {
            key: secondKey,
            kind: "direct",
            label: "Second running session",
            updatedAt: 1,
            activeRunIds: ["run-second"],
            hasActiveRun: true,
            status: "running",
          },
        ]),
      },
      sessionKey: firstKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const secondRow = page.locator(`.sidebar-recent-session[data-session-key="${secondKey}"]`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.messages.subscribe")).some(
            (request) => requireRecord(request.params).key === secondKey,
          ),
        )
        .toBe(true);
      await gateway.emitGatewayEvent("agent", {
        sessionKey: secondKey,
        runId: "run-second",
        stream: "tool",
        data: { name: "bash" },
      });
      await secondRow.getByText("Using bash").waitFor();
      const heightBefore = await secondRow.evaluate((row) => row.getBoundingClientRect().height);
      if (captureUiProofEnabled) {
        await page.waitForTimeout(800);
        await secondRow.screenshot({
          path: path.join(subtitleStabilityProofDir, "01-running-before-open.png"),
        });
      }

      await secondRow.locator("a.sidebar-recent-session__link").click();
      await expect.poll(() => secondRow.getAttribute("class")).toContain("--active");
      await secondRow.getByText("Using bash").waitFor();
      const heightAfter = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

      // Sub-pixel tolerance: getBoundingClientRect returns 1/65536 fractions that
      // drift under CPU contention, so exact equality fails ~1 run in 3 in a loaded
      // shard. The contract is "the row does not change size", not bit-identical floats.
      expect(heightAfter).toBeCloseTo(heightBefore, 1);
      if (captureUiProofEnabled) {
        await page.waitForTimeout(800);
        await secondRow.screenshot({
          path: path.join(subtitleStabilityProofDir, "02-running-after-open.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(subtitleStabilityProofDir, "sidebar-subtitle-stability.webm"),
        );
      }
    }
  });

  it("replaces an intermediate running subtitle with the unread final digest", async () => {
    if (captureUiProofEnabled) {
      await mkdir(terminalMetadataProofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: terminalMetadataProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const key = "agent:main:session-a";
    const runId = "run-sidebar-metadata";
    const running = chatSessionListResponse([
      {
        key,
        kind: "direct",
        label: "Sidebar metadata repair",
        updatedAt: Date.now(),
        activeRunIds: [runId],
        hasActiveRun: true,
        status: "running",
        observerDigest: {
          agentId: "main",
          runId,
          headline: "Implementing the repair",
          health: "on-track",
          updatedAt: Date.now(),
          revision: 1,
        },
      },
    ]);
    const completed = chatSessionListResponse([
      {
        key,
        kind: "direct",
        label: "Sidebar metadata repair",
        updatedAt: Date.now() + 1,
        activeRunIds: [],
        hasActiveRun: false,
        status: "done",
        lastMessagePreview: "The repaired sidebar now shows the final reply.",
        observerDigest: {
          agentId: "main",
          runId,
          headline: "Repair landed cleanly",
          health: "done",
          updatedAt: Date.now() + 1,
          revision: 2,
        },
      },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": running },
      sessionKey: key,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.getByText("Implementing the repair").waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(terminalMetadataProofDir, "01-running-subtitle.png"),
        });
      }
      await gateway.setMethodResponse("sessions.list", completed);
      const listCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: {
          content: [{ type: "text", text: "The repaired sidebar now shows the final reply." }],
          role: "assistant",
          timestamp: Date.now(),
        },
        messageId: "terminal-sidebar-reply",
        messageSeq: 2,
        session: expectDefined(completed.sessions[0], "completed sidebar session fixture"),
        sessionKey: key,
        status: "done",
      });
      await row.getByText("Repair landed cleanly").waitFor();
      await expectRequestCountStable(gateway, "sessions.list", listCount);
      expect(await row.textContent()).not.toContain("[[");
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(terminalMetadataProofDir, "02-final-reply-subtitle.png"),
        });
      }
      const listRequests = await gateway.getRequests("sessions.list");
      expect(listRequests.at(-1)?.params).toMatchObject({ includeLastMessage: true });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps long sidebar labels clipped after a session switch", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const sessions = chatSessionListResponse();
    const firstSession = expectDefined(sessions.sessions[0], "first chat session fixture");
    const secondSession = expectDefined(sessions.sessions[1], "second chat session fixture");
    firstSession.label = "Title fits until actions appear";
    secondSession.label =
      "Review and repair the intentionally overlong sidebar session title before navigation ".repeat(
        4,
      );
    await installMockGateway(page, {
      methodResponses: { "sessions.list": sessions },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const recentRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"]',
      );
      const recentLabel = recentRow.locator(".sidebar-recent-session__name");
      await recentLabel.waitFor({ state: "visible", timeout: 10_000 });
      const layout = await recentLabel.evaluate((label) => ({
        clientWidth: label.clientWidth,
        linkWidth: label.parentElement?.clientWidth ?? 0,
        rowWidth: label.closest<HTMLElement>(".sidebar-recent-session")?.clientWidth ?? 0,
        scrollWidth: label.scrollWidth,
        text: label.textContent,
      }));
      expect(layout.scrollWidth, JSON.stringify(layout)).toBeGreaterThan(layout.clientWidth);

      const hoverOnlyRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-a"]',
      );
      const hoverOnlyLabel = hoverOnlyRow.locator(".sidebar-recent-session__name");
      const restingHoverOnlyLayout = await hoverOnlyLabel.evaluate((label) => {
        const viewport = label.parentElement as HTMLElement;
        const style = getComputedStyle(viewport);
        return {
          scrollWidth: label.scrollWidth,
          viewportWidth:
            viewport.clientWidth -
            (Number.parseFloat(style.paddingLeft) || 0) -
            (Number.parseFloat(style.paddingRight) || 0),
        };
      });
      expect(
        restingHoverOnlyLayout.scrollWidth,
        JSON.stringify(restingHoverOnlyLayout),
      ).toBeLessThanOrEqual(restingHoverOnlyLayout.viewportWidth);
      await hoverOnlyRow.hover();
      const hoveredHoverOnlyLayout = await hoverOnlyLabel.evaluate((label) => {
        const viewport = label.parentElement as HTMLElement;
        const style = getComputedStyle(viewport);
        return {
          scrollWidth: label.scrollWidth,
          viewportWidth:
            viewport.clientWidth -
            (Number.parseFloat(style.paddingLeft) || 0) -
            (Number.parseFloat(style.paddingRight) || 0),
        };
      });
      expect(
        hoveredHoverOnlyLayout.scrollWidth,
        JSON.stringify(hoveredHoverOnlyLayout),
      ).toBeGreaterThan(hoveredHoverOnlyLayout.viewportWidth);
      await expect
        .poll(() => hoverOnlyLabel.evaluate((label) => label.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");
      await page.mouse.move(0, 0);

      // Freeze the clock so the 500ms hover-intent delay elapses only via
      // runFor; a ticking clock let slow runners start the marquee before the
      // "not yet scrolling" asserts below.
      await pauseVirtualClock(page);

      await recentRow.dispatchEvent("mouseenter");
      await page.clock.runFor(250);
      expect(await recentLabel.evaluate((label) => label.classList.value)).not.toContain(
        "hover-marquee--scrolling",
      );
      await recentRow.dispatchEvent("mouseleave");
      // 250 + 300 exceeds the hover delay: only the leave-cancel keeps it off.
      await page.clock.runFor(300);
      expect(await recentLabel.evaluate((label) => label.classList.value)).not.toContain(
        "hover-marquee--scrolling",
      );
      await recentRow.dispatchEvent("mouseenter");
      await page.clock.runFor(520);
      await expect
        .poll(() => recentLabel.evaluate((label) => label.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");
      // Resume real time: the snap-back below is a compositor-driven CSS
      // transition, not a fake-timer callback.
      await page.clock.resume();
      await recentRow.dispatchEvent("mouseleave");
      await expect
        .poll(
          () =>
            recentLabel.evaluate((label) => ({
              textIndent: getComputedStyle(label).textIndent,
              textOverflow: getComputedStyle(label).textOverflow,
            })),
          { timeout: 1_500 },
        )
        .toEqual({ textIndent: "0px", textOverflow: "ellipsis" });

      await recentRow.locator("a.sidebar-recent-session__link").dispatchEvent("click", {
        button: 0,
      });
      await page.locator(".sidebar-recent-session--active").getByText(secondSession.label).waitFor({
        timeout: 10_000,
      });

      const activeRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-b"]',
      );
      expect(
        await activeRow.locator(".sidebar-recent-session__name").evaluate((label) => ({
          textIndent: getComputedStyle(label).textIndent,
          textOverflow: getComputedStyle(label).textOverflow,
        })),
      ).toEqual({ textIndent: "0px", textOverflow: "ellipsis" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps session titles on the first line and collapses rows that have no second line", async () => {
    if (captureUiProofEnabled) {
      await mkdir(sessionSecondRowProofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: sessionSecondRowProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const busyKey = "agent:main:busy-session";
    const plainKey = "agent:main:plain-session";
    const longKey = "agent:main:long-title-session";
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: busyKey,
            kind: "direct",
            label: "Terminal tab bar redesign proposal",
            updatedAt: 2,
            activeRunIds: ["run-busy-session"],
            hasActiveRun: true,
            observerDigest: {
              agentId: "main",
              runId: "run-busy-session",
              headline:
                "The isolated clone is ready, but direct Git fetch and every remaining operation continue in the background",
              health: "on-track",
              updatedAt: 2,
              revision: 1,
            },
            incognito: true,
            hasAutomation: true,
            status: "running",
            unread: true,
          },
          {
            key: plainKey,
            kind: "direct",
            label: "A session without secondary metadata",
            updatedAt: 1,
          },
          {
            key: longKey,
            kind: "direct",
            label:
              "An extremely long single-line session title that keeps going and going far past the sidebar width",
            updatedAt: 1,
            activeRunIds: ["run-long-title"],
            hasActiveRun: true,
            status: "running",
            unread: true,
          },
        ]),
      },
      sessionKey: plainKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const busyRow = page.locator(`.sidebar-recent-session[data-session-key="${busyKey}"]`);
      const plainRow = page.locator(`.sidebar-recent-session[data-session-key="${plainKey}"]`);
      await busyRow.locator(".session-row-badges").waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(sessionSecondRowProofDir, "01-second-row-endcap.png"),
        });
      }

      const layout = await busyRow.evaluate((row) => {
        const rect = (selector: string) => {
          const element = row.querySelector<HTMLElement>(selector);
          if (!element) {
            throw new Error(`Missing session row fixture ${selector}`);
          }
          const box = element.getBoundingClientRect();
          return {
            bottom: box.bottom,
            height: box.height,
            left: box.left,
            right: box.right,
            top: box.top,
          };
        };
        return {
          atoms: Array.from(
            row.querySelectorAll(
              ".sidebar-recent-session__details-endcap :is(svg, .session-run-spinner, .session-unread-dot)",
            ),
            (element) => {
              const box = element.getBoundingClientRect();
              return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
            },
          ),
          badges: rect(".session-row-badges"),
          busyHeight: row.getBoundingClientRect().height,
          endcap: rect(".sidebar-recent-session__details-endcap"),
          name: rect(".sidebar-recent-session__name"),
          spinner: rect(".session-run-spinner"),
          state: rect(".session-row-state"),
          subtitle: rect(".sidebar-recent-session__subtitle"),
        };
      });
      const plain = await plainRow.evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        singleLine: row.classList.contains("sidebar-recent-session--single-line"),
      }));

      // A row with no secondary metadata no longer reserves the second line: it
      // collapses so its endcap rides beside the title instead of hanging alone
      // beneath it. Only rows that actually have a subtitle keep the two-line shape.
      expect(plain.singleLine).toBe(true);
      expect(plain.height).toBeLessThan(layout.busyHeight);
      // Badges belong to the second line. Comparing centres keeps this true
      // whatever size the row's glyphs are; the old top-edge slack was
      // calibrated to one particular glyph size.
      expect((layout.badges.top + layout.badges.bottom) / 2).toBeGreaterThan(
        (layout.name.top + layout.name.bottom) / 2,
      );
      expect(layout.name.right).toBeGreaterThan(layout.badges.left);
      expect((layout.badges.top + layout.badges.bottom) / 2).toBeCloseTo(
        (layout.subtitle.top + layout.subtitle.bottom) / 2,
        1,
      );
      expect((layout.state.top + layout.state.bottom) / 2).toBeCloseTo(
        (layout.subtitle.top + layout.subtitle.bottom) / 2,
        1,
      );
      expect(layout.state.left).toBeGreaterThanOrEqual(layout.endcap.left);
      expect(layout.state.right).toBeLessThanOrEqual(layout.endcap.right);
      expect(layout.spinner.left).toBeGreaterThanOrEqual(layout.endcap.left);
      expect(layout.spinner.right).toBeLessThanOrEqual(layout.endcap.right);
      expect(layout.atoms.length).toBeGreaterThanOrEqual(3);
      for (const atom of layout.atoms) {
        expect(atom.left).toBeGreaterThanOrEqual(layout.endcap.left);
        expect(atom.right).toBeLessThanOrEqual(layout.endcap.right);
        expect(atom.top).toBeGreaterThanOrEqual(layout.endcap.top);
        expect(atom.bottom).toBeLessThanOrEqual(layout.endcap.bottom);
      }

      // A long title must truncate instead of crushing the collapsed row's icon
      // endcap: the spinner/unread icons keep their intrinsic width and stay
      // inside the row, exactly like the two-line endcap under a long subtitle.
      const longRow = page.locator(`.sidebar-recent-session[data-session-key="${longKey}"]`);
      const longLayout = await longRow.evaluate((row) => {
        const endcap = row.querySelector(".sidebar-recent-session__details-endcap");
        const name = row.querySelector(".sidebar-recent-session__name");
        if (!endcap || !name) {
          throw new Error("Missing long-title session row fixture");
        }
        const endcapBox = endcap.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return {
          atoms: Array.from(
            endcap.querySelectorAll(":scope :is(svg, .session-run-spinner, .session-unread-dot)"),
            (element) => element.getBoundingClientRect().width,
          ),
          endcapWidth: endcapBox.width,
          endcapRight: endcapBox.right,
          nameOverflowing: name.scrollWidth > name.clientWidth,
          rowRight: rowBox.right,
          singleLine: row.classList.contains("sidebar-recent-session--single-line"),
        };
      });
      expect(longLayout.singleLine).toBe(true);
      expect(longLayout.nameOverflowing).toBe(true);
      expect(longLayout.endcapRight).toBeLessThanOrEqual(longLayout.rowRight);
      const intrinsicAtomWidth = longLayout.atoms.reduce((sum, width) => sum + width, 0);
      expect(intrinsicAtomWidth).toBeGreaterThan(0);
      expect(longLayout.endcapWidth).toBeGreaterThanOrEqual(intrinsicAtomWidth);

      await busyRow.hover();
      await expect
        .poll(() =>
          busyRow
            .locator(".sidebar-recent-session__details-endcap")
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        // The actions sit on the title line now, so the second line keeps its
        // status icons instead of trading them for the buttons on hover.
        .toBe("1");
      await expect
        .poll(() =>
          busyRow
            .locator("[data-session-menu]")
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("1");
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(sessionSecondRowProofDir, "02-hover-actions.png"),
        });
      }
      await plainRow.waitFor();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the authenticated assistant avatar stable across same-agent switches", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const avatarBody = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route(/\/avatar\/main\?meta=1$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ avatarUrl: "/avatar/main", avatarStatus: "local" }),
      }),
    );
    await page.route(/\/avatar\/main$/, (route) =>
      route.fulfill({ contentType: "image/png", body: avatarBody }),
    );
    await installMockGateway(page, {
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const documentMarker = await page.evaluate(() => {
        const marker = crypto.randomUUID();
        (window as Window & { __openclawAvatarTestDocument?: string })[
          "__openclawAvatarTestDocument"
        ] = marker;
        return marker;
      });
      const avatar = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] img.agent-chat__welcome-avatar',
      );
      await avatar.waitFor({ state: "visible" });
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);

      const sessionRow = (sessionKey: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const sessionB = sessionRow("agent:main:session-b");
      await sessionB.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionB.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);

      const sessionA = sessionRow("agent:main:session-a");
      await sessionA.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionA.getAttribute("class"))
        .toContain("sidebar-recent-session--active");

      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __openclawAvatarTestDocument?: string })[
              "__openclawAvatarTestDocument"
            ],
        ),
      ).toBe(documentMarker);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves adopted-row focus across repeated catalog reorders", async () => {
    const context = await suite.newBrowserContext({});
    const page = await context.newPage();
    const firstKey = "agent:main:first-adopted";
    const secondKey = "agent:main:second-adopted";
    const catalogResponse = (order: ReadonlyArray<readonly [string, string]>) => ({
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
              sessions: order.map(([threadId, sessionKey]) => ({
                threadId,
                sessionKey,
                name: threadId,
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              })),
            },
          ],
        },
      ],
    });
    const initialOrder = [
      ["First adopted", firstKey],
      ["Second adopted", secondKey],
    ] as const;
    const reversedOrder = initialOrder.toReversed();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list", "sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: firstKey,
            kind: "direct",
            label: "First adopted",
            updatedAt: 2,
            childSessions: ["agent:main:child"],
          },
          { key: secondKey, kind: "direct", label: "Second adopted", updatedAt: 1 },
        ]),
        "sessions.catalog.list": catalogResponse(initialOrder),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalog = page.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      const toggle = catalog.locator(".sidebar-session-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const rows = catalog.locator(".sidebar-session-catalog-host__sessions > [data-session-key]");
      for (const [control, selector] of [
        ["link", ".sidebar-recent-session__link"],
        ["child-toggle", "[data-child-session-toggle]"],
        ["pin", "[data-sidebar-session-pin]"],
        ["menu", "[data-session-menu]"],
      ] as const) {
        const requestCount = (await gateway.getRequests("sessions.catalog.list")).length;
        await gateway.setMethodResponse("sessions.catalog.list", catalogResponse(initialOrder));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect
          .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
          .toBeGreaterThan(requestCount);
        await expect
          .poll(() => rows.evaluateAll((elements) => elements.map((row) => row.dataset.sessionKey)))
          .toEqual(initialOrder.map(([, sessionKey]) => sessionKey));
        const focusedControl = catalog.locator(`[data-session-key="${firstKey}"] ${selector}`);
        await focusedControl.focus();
        await focusedControl.evaluate((element, value) => {
          element.setAttribute("data-focus-probe", value);
        }, control);

        for (const order of [reversedOrder, initialOrder, reversedOrder]) {
          const reorderRequestCount = (await gateway.getRequests("sessions.catalog.list")).length;
          await gateway.setMethodResponse("sessions.catalog.list", catalogResponse(order));
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect
            .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
            .toBeGreaterThan(reorderRequestCount);
          await expect
            .poll(() =>
              rows.evaluateAll((elements) => elements.map((row) => row.dataset.sessionKey)),
            )
            .toEqual(order.map(([, sessionKey]) => sessionKey));
          expect(await focusedControl.getAttribute("data-focus-probe")).toBe(control);
          await expect
            .poll(() => focusedControl.evaluate((element) => element === document.activeElement))
            .toBe(true);
        }
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("resets an adopted catalog marquee when its label becomes short", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:adopted-marquee";
    const catalogResponse = (name: string) => ({
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
                  threadId: "thread-adopted-marquee",
                  sessionKey,
                  name,
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
            },
          ],
        },
      ],
    });
    const initialName = "Trace every adopted catalog refresh before releasing the sidebar";
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          { key: sessionKey, kind: "direct", label: initialName, updatedAt: 1 },
        ]),
        "sessions.catalog.list": catalogResponse(initialName),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalog = page.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      const toggle = catalog.locator(".sidebar-session-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const row = catalog.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      const menu = row.locator("[data-session-menu]");
      await expect
        .poll(() => menu.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await menu.hover();
      const label = row.locator(".hover-marquee");
      await expect
        .poll(() => label.evaluate((element) => element.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");

      const requestCount = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", catalogResponse("Short"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBeGreaterThan(requestCount);
      await expect.poll(() => label.textContent()).toBe("Short");
      expect(await row.evaluate((element) => element.matches(":hover"))).toBe(true);
      await expect
        .poll(() => label.evaluate((element) => element.classList.value))
        .not.toContain("hover-marquee--scrolling");
      await expect
        .poll(() =>
          label.evaluate((element) => element.style.getPropertyValue("--hover-marquee-shift")),
        )
        .toBe("");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("remeasures an adopted marquee when live endcap state changes", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:adopted-live-marquee";
    const label = "Trace every adopted session transition before releasing the sidebar";
    const catalogResponse = {
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
                  threadId: "thread-adopted-live-marquee",
                  sessionKey,
                  name: label,
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
            },
          ],
        },
      ],
    };
    const sessionResponse = (state: Record<string, unknown> = {}) =>
      chatSessionListResponse([
        {
          key: sessionKey,
          kind: "direct",
          label,
          updatedAt: 1,
          ...state,
        },
      ]);
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": sessionResponse(),
        "sessions.catalog.list": catalogResponse,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalog = page.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      const toggle = catalog.locator(".sidebar-session-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const row = catalog.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      const menu = row.locator("[data-session-menu]");
      await expect
        .poll(() => menu.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await menu.hover();
      const marquee = row.locator(".hover-marquee");
      await expect
        .poll(() => marquee.evaluate((element) => element.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");
      const idleShift = await marquee.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue("--hover-marquee-shift")),
      );

      const refreshSessions = async (state: Record<string, unknown>) => {
        const requestCount = (await gateway.getRequests("sessions.list")).length;
        await gateway.setMethodResponse("sessions.list", sessionResponse(state));
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "update",
          sessionKey,
        });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(requestCount);
      };

      await refreshSessions({
        activeRunIds: ["run-adopted-live-marquee"],
        hasActiveRun: true,
        status: "running",
        updatedAt: 2,
      });
      await row.locator(".session-run-spinner").waitFor();
      expect(await row.evaluate((element) => element.matches(":hover"))).toBe(true);
      await expect
        .poll(() =>
          marquee.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--hover-marquee-shift")),
          ),
        )
        .toBeLessThan(idleShift);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restarts a catalog marquee when its hovered label changes", async () => {
    const context = await suite.newBrowserContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const catalogResponse = (name: string, pullRequest?: { numbers: number[]; state: "open" }) => ({
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
                  threadId: "thread-hovered",
                  name,
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                  ...(pullRequest ? { pullRequest } : {}),
                },
              ],
            },
          ],
        },
      ],
    });
    const initialName = "Trace the complete native catalog refresh lifecycle before release";
    const updatedName = "Verify the rewritten catalog title keeps scrolling under the pointer";
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "sessions.catalog.list": catalogResponse(initialName),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const catalog = page.locator('[data-session-section="catalog:codex"]');
      await catalog.waitFor({ state: "visible" });
      const toggle = catalog.locator(".sidebar-session-group-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const row = catalog.locator('[data-session-key$=":thread-hovered"]');
      await row.hover();
      const menu = row.locator("[data-catalog-session-menu]");
      await expect
        .poll(() => menu.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await menu.hover();
      const initialLabel = row.locator(".hover-marquee");
      await expect
        .poll(() => initialLabel.evaluate((element) => element.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");

      const requestCount = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", catalogResponse(updatedName));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBeGreaterThan(requestCount);
      const label = row.locator(".hover-marquee");
      await expect.poll(() => label.textContent()).toBe(updatedName);
      expect(await row.evaluate((element) => element.matches(":hover"))).toBe(true);
      await expect
        .poll(() => label.evaluate((element) => element.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");

      const shiftWithoutBadge = await label.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue("--hover-marquee-shift")),
      );
      const badgeRequestCount = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse(
        "sessions.catalog.list",
        catalogResponse(updatedName, { numbers: [125820], state: "open" }),
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBeGreaterThan(badgeRequestCount);
      await row
        .locator('.session-row-badge--pull-request[data-pull-request-state="open"]')
        .waitFor();
      await expect
        .poll(() => label.evaluate((element) => element.classList.value), { timeout: 1_500 })
        .toContain("hover-marquee--scrolling");
      await expect
        .poll(() =>
          label.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--hover-marquee-shift")),
          ),
        )
        .toBeLessThan(shiftWithoutBadge);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
