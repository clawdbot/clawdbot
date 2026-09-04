import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("routes non-default-agent media to the selected session before applying bootstrap roots", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:research:main";
    const source = "/home/research/.openclaw/media/outbound/report.png";
    const ticket = "ticket-research-image";
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("meta") === "1") {
        // The main HTTP route resolves the default agent, not the selected research session.
        await route.fulfill({
          json: {
            available: false,
            code: "outside-allowed-folders",
            reason: "Outside allowed folders",
          },
        });
        return;
      }
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.get("mediaTicket")).toBe(ticket);
      await route.fulfill({
        contentType: "image/png",
        body: await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png")),
      });
    });
    const gateway = await installMockGateway(page, {
      sessionKey,
      localMediaPreviewRoots: ["/home/main/.openclaw/media/outbound"],
      featureMethods: [...defaultControlUiFeatureMethods, "assistant.media.get"],
      methodResponses: {
        "assistant.media.get": {
          available: true,
          mediaTicket: ticket,
          mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
      historyMessages: [
        {
          id: "assistant-research-local-image",
          role: "assistant",
          content: [{ type: "image", url: source, alt: "Research report" }],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const image = page.getByAltText("Research report");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      const request = await gateway.waitForRequest("assistant.media.get");
      expect(request.params).toEqual({ source, sessionKey });
      expect(await page.getByText("Outside allowed folders").count()).toBe(0);
    } finally {
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
        await page.screenshot({
          fullPage: true,
          path: path.join(suite.artifactDir, "selected-session-media.png"),
        });
      }
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    {
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      source: "/home/node/private/bootstrap-secret.mp3",
    },
    {
      code: "file-not-found",
      reason: "File not found",
      source: "/home/node/.openclaw/media/outbound/bootstrap-missing.mp3",
    },
  ] as const)(
    "keeps server-rejected $code media blocked before preview roots load",
    async ({ code, reason, source }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "assistant.media.get"],
        methodResponses: {
          "assistant.media.get": { available: false, code, reason },
        },
        historyMessages: [
          {
            id: `assistant-bootstrap-blocked-${code}`,
            role: "assistant",
            content: [{ type: "text", text: `Unavailable recording\nMEDIA:${source}` }],
            timestamp: Date.now(),
          },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const status = page.locator(".chat-assistant-attachment-card__status-meta");
        await status.waitFor({ state: "visible", timeout: 10_000 });
        await expect.poll(() => status.textContent()).toContain(reason);
        const request = await gateway.waitForRequest("assistant.media.get");
        expect(request.params).toEqual({ source, sessionKey: "agent:main:main" });
        expect(await page.locator(".chat-assistant-attachment-card audio").count()).toBe(0);
        expect(await page.locator(".chat-assistant-attachment-card__download").count()).toBe(0);

        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, `bootstrap-blocked-${code}.png`),
          });
        }
        if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify({
              proof: "control-ui-local-media-bootstrap",
              code,
              source,
              metadataAuthenticatedByGateway: true,
              rawMediaRequested: false,
              visibleReason: reason,
            })}\n`,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
