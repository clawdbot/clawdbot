import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  pauseVirtualClock,
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

suite.define(() => {
  it("replaces an intermediate running subtitle with the durable final reply", async () => {
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
          headline: "Implementing the repair",
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
        sessionKey: key,
        status: "done",
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listCount);
      await row.getByText("The repaired sidebar now shows the final reply.").waitFor();
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

  it("keeps session titles on the first line and status on a fixed second line", async () => {
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
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: busyKey,
            kind: "direct",
            label: "Terminal tab bar redesign proposal",
            updatedAt: 2,
            lastMessagePreview: "Implemented and committed as 094ab2",
            incognito: true,
            hasAutomation: true,
            status: "done",
            unread: true,
          },
          {
            key: plainKey,
            kind: "direct",
            label: "A session without secondary metadata",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: busyKey,
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
          badges: rect(".session-row-badges"),
          busyHeight: row.getBoundingClientRect().height,
          name: rect(".sidebar-recent-session__name"),
          state: rect(".session-row-state"),
          subtitle: rect(".sidebar-recent-session__subtitle"),
        };
      });
      const plainHeight = await plainRow.evaluate((row) => row.getBoundingClientRect().height);

      expect(layout.busyHeight).toBeCloseTo(plainHeight, 1);
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

      await busyRow.hover();
      await expect
        .poll(() =>
          busyRow
            .locator(".sidebar-recent-session__details-endcap")
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("0");
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
});
