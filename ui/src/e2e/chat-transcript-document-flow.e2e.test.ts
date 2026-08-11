// Control UI E2E tests cover multi-party transcript identity presentation.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI document-flow transcript",
  startServerBeforeBrowser: true,
});

async function captureProof(page: import("playwright").Page, theme: "dark" | "light") {
  const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifactDir, `${theme}.png`),
  });
}

suite.define(() => {
  it("presents every human and agent message in one left-aligned document flow", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const now = Date.now();
    const sessionKey = "agent:main:group:refactor-review";

    await installMockGateway(page, {
      assistantName: "Roboclaw",
      presenceUsers: [
        {
          self: true,
          id: "fixture-vyctor",
          name: "Vyctor Brzezowski",
          email: "vyctor@example.test",
          watchedSessions: [sessionKey],
        },
        {
          id: "fixture-colin",
          name: "Colin",
          email: "colin@example.test",
          watchedSessions: [sessionKey],
        },
      ],
      sessionKey,
      historyMessages: [
        {
          role: "user",
          content:
            "Roboclaw, can you split the session-sidebar refactor into reviewable files without changing the gateway contract?",
          timestamp: now - 8 * 60_000,
          __openclaw: {
            id: "fixture-colin-message",
            senderId: "fixture-colin",
            senderName: "Colin",
            seq: 1,
          },
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Yes. I’ll keep the refactor inside the Control UI:",
                "",
                "- move session-row rendering into the existing sidebar component",
                "- preserve the virtualized transcript and scroll anchors",
                "- cover the member, agent, and operator identity paths in one browser scenario",
              ].join("\n"),
            },
          ],
          timestamp: now - 7 * 60_000,
          __openclaw: { id: "fixture-roboclaw-plan", seq: 2 },
        },
        {
          role: "user",
          content:
            "I reviewed the first pass. Keep tool failures inline, and make the sender line do all the identity work so the layout still reads cleanly with more people in the thread.",
          timestamp: now - 5 * 60_000,
          __openclaw: {
            id: "fixture-vyctor-message",
            senderId: "fixture-vyctor",
            senderName: "Vyctor Brzezowski",
            seq: 3,
          },
        },
        {
          role: "toolResult",
          toolName: "shell",
          content: "UI snapshot check failed: expected transcript identity baseline is stale.",
          isError: true,
          timestamp: now - 4 * 60_000,
          __openclaw: { id: "fixture-tool-error", seq: 4, turnBoundary: true },
        },
        {
          role: "assistant",
          content:
            "The snapshot failure was the old bubble layout, not a runtime regression. I updated the presentation layer only; message data, grouping, and gateway behavior are unchanged.",
          timestamp: now - 2 * 60_000,
          __openclaw: { id: "fixture-roboclaw-result", seq: 5 },
        },
      ],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page
        .getByText("The snapshot failure was the old bubble layout", { exact: false })
        .waitFor();

      const toolDisclosure = page.locator(".chat-group.tool button[aria-expanded]").first();
      if (
        (await toolDisclosure.count()) > 0 &&
        (await toolDisclosure.getAttribute("aria-expanded")) !== "true"
      ) {
        await toolDisclosure.click();
      }
      expect(await page.locator(".chat-group.tool").count()).toBe(1);

      const presentations: Array<{
        backgrounds: string[];
        borderWidths: string[];
        headerBeforeBody: boolean[];
        headerOpacity: string[];
        messageX: number[];
        visibleAvatars: boolean[];
      }> = [];

      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((nextTheme) => {
          document.documentElement.dataset.theme = "claw";
          document.documentElement.dataset.themeMode = nextTheme;
        }, theme);
        await page.waitForTimeout(100);

        const groups = page.locator(".chat-group.user, .chat-group.assistant");
        expect(await groups.count()).toBe(4);
        presentations.push(
          await groups.evaluateAll((nodes) => {
            const rows = nodes.map((node) => {
              const avatar = node.querySelector<HTMLElement>(".chat-avatar");
              const body = node.querySelector<HTMLElement>(".chat-group-messages");
              const header = node.querySelector<HTMLElement>(".chat-group-footer");
              const bubbles = [...node.querySelectorAll<HTMLElement>(".chat-bubble")];
              const bodyBox = body?.getBoundingClientRect();
              const headerBox = header?.getBoundingClientRect();
              return {
                backgrounds: bubbles.map((bubble) => getComputedStyle(bubble).backgroundColor),
                borderWidths: bubbles.map((bubble) => getComputedStyle(bubble).borderTopWidth),
                headerBeforeBody: Boolean(
                  headerBox && bodyBox && headerBox.bottom <= bodyBox.top + 1,
                ),
                headerOpacity: header ? getComputedStyle(header).opacity : "missing",
                messageX: bodyBox?.x ?? Number.NaN,
                visibleAvatar: Boolean(avatar && avatar.getClientRects().length > 0),
              };
            });
            return {
              backgrounds: rows.flatMap((row) => row.backgrounds),
              borderWidths: rows.flatMap((row) => row.borderWidths),
              headerBeforeBody: rows.map((row) => row.headerBeforeBody),
              headerOpacity: rows.map((row) => row.headerOpacity),
              messageX: rows.map((row) => row.messageX),
              visibleAvatars: rows.map((row) => row.visibleAvatar),
            };
          }),
        );
        await captureProof(page, theme);
      }

      expect(
        await page
          .locator(".chat-group:is(.user, .assistant) .chat-group-footer__meta .chat-sender-name")
          .allTextContents(),
      ).toEqual(["Colin", "Roboclaw", "Vyctor Brzezowski", "Roboclaw"]);
      for (const presentation of presentations) {
        expect(presentation.visibleAvatars.every(Boolean)).toBe(true);
        expect(presentation.headerBeforeBody.every(Boolean)).toBe(true);
        expect(presentation.headerOpacity.every((opacity) => opacity === "1")).toBe(true);
        expect(
          Math.max(...presentation.messageX) - Math.min(...presentation.messageX),
        ).toBeLessThan(2);
        expect(
          presentation.backgrounds.every((background) => background === "rgba(0, 0, 0, 0)"),
        ).toBe(true);
        expect(presentation.borderWidths.every((width) => width === "0px")).toBe(true);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
