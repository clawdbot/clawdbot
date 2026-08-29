import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
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
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
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
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
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
    firstSession.label = "Short";
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
      await page.clock.runFor(500);
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
    const homeKey = "agent:main:main";
    await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
      methodResponses: {
        "board.get": {
          cases: [homeKey, busyKey, plainKey, longKey].map((sessionKey) => ({
            match: { sessionKey },
            response: {
              sessionKey,
              revision: 1,
              tabs:
                sessionKey === homeKey || sessionKey === busyKey
                  ? [{ tabId: "overview", title: "Overview", position: 0, chatDock: "right" }]
                  : [],
              widgets: [],
            },
          })),
        },
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
      expect(await busyRow.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      expect(await busyRow.getAttribute("class")).toContain("sidebar-recent-session--single-line");
      if (captureUiProofEnabled) {
        await page.locator(".shell-nav").screenshot({
          path: path.join(sessionSecondRowProofDir, "00-default-hidden-preview.png"),
        });
      }
      await page.locator(".sidebar-session-toolbar .sidebar-session-sort").click();
      const previewToggle = page.locator('wa-dropdown-item[value="show-preview"]');
      expect(
        await previewToggle.evaluate(
          (item) => (item as HTMLElement & { checked: boolean }).checked,
        ),
      ).toBe(false);
      await previewToggle.click();
      await busyRow.locator(".sidebar-recent-session__subtitle").waitFor();
      const sidebar = page.locator("openclaw-app-sidebar");
      const homeBoard = sidebar
        .locator(".nav-item--home")
        .getByRole("img", { name: "Dashboard available" })
        .locator("svg");
      const sessionBoard = busyRow.getByRole("img", { name: "Dashboard available" }).locator("svg");
      const ordinaryBadge = busyRow.locator(".session-row-badge--incognito svg");
      await homeBoard.waitFor({ state: "visible" });
      await sessionBoard.waitFor({ state: "visible" });
      const automationBadge = busyRow
        .getByRole("img", { name: "Automation attached" })
        .locator("svg");
      for (const colorScheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(colorScheme);
        const automationStyle = await automationBadge.evaluate((element) => {
          const style = getComputedStyle(element);
          return { color: style.color, strokeWidth: style.strokeWidth };
        });
        for (const board of [homeBoard, sessionBoard]) {
          expect
            .soft(
              await board.evaluate((element) => {
                const style = getComputedStyle(element);
                return { color: style.color, strokeWidth: style.strokeWidth };
              }),
            )
            .toEqual(automationStyle);
        }
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
          await page.emulateMedia({ reducedMotion });
          const spinnerColors = await busyRow
            .locator(".session-run-spinner")
            .evaluate((element) => {
              const style = getComputedStyle(element);
              const accent = document.createElement("span").style;
              accent.color = style.getPropertyValue("--accent").trim();
              return { actual: style.borderTopColor, expected: accent.color };
            });
          expect.soft(spinnerColors.actual).toBe(spinnerColors.expected);
        }
        await page.emulateMedia({ reducedMotion: "no-preference" });
        if (captureUiProofEnabled) {
          await page.locator(".shell-nav").screenshot({
            animations: "disabled",
            path: path.join(sessionSecondRowProofDir, `indicators-${colorScheme}.png`),
          });
        }
      }
      const shellNav = page.locator(".shell-nav");
      const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
      const badgeSizes = [];
      for (const sidebarWidth of [258, 240]) {
        if (sidebarWidth === 240) {
          await sidebarResizer.focus();
          await page.keyboard.press("Home");
        }
        await expect
          .poll(async () => Math.round((await shellNav.boundingBox())?.width ?? 0))
          .toBe(sidebarWidth);
        await page.mouse.move(900, 400);
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(sessionSecondRowProofDir, `01-second-row-endcap-${sidebarWidth}.png`),
          });
          await shellNav.screenshot({
            animations: "disabled",
            path: path.join(sessionSecondRowProofDir, `01-sidebar-${sidebarWidth}.png`),
          });
        }
        badgeSizes.push(
          await Promise.all(
            [homeBoard, sessionBoard, ordinaryBadge].map((icon) =>
              icon.evaluate((element) => {
                const { height, width } = element.getBoundingClientRect();
                return { height, width };
              }),
            ),
          ),
        );
      }

      // Rotation expands the spinner element's square DOMRect even though its
      // circular ink is unchanged; freeze it while asserting endcap geometry.
      await page.addStyleTag({ content: ".session-run-spinner { animation: none !important; }" });
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
      expect(layout.badges.top).toBeGreaterThanOrEqual(layout.name.bottom - 1);
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
      for (const sizes of badgeSizes) {
        expect(sizes).toEqual([
          { height: 12, width: 12 },
          { height: 12, width: 12 },
          { height: 12, width: 12 },
        ]);
      }
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
});
