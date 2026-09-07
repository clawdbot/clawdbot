import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import {
  buildLocalWebchatAudioMessage,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const mediaTempDirs = useAutoCleanupTempDirTracker(afterEach);

suite.define(() => {
  it.each([
    {
      kind: "audio",
      source: "/home/node/.openclaw/media/outbound/bootstrap-voice.mp3",
      ticket: "ticket-bootstrap-audio",
    },
    {
      kind: "image",
      source: "/home/node/.openclaw/media/outbound/bootstrap-image.png",
      ticket: "ticket-bootstrap-image",
    },
    {
      kind: "image",
      source: "/projects/chat-worktree/.openclaw/tmp/review/preview.png",
      ticket: "ticket-project-image",
      revalidatePolicy: true,
    },
    {
      kind: "image",
      source: "FILE:///home/node/.openclaw/media/outbound/bootstrap-uppercase-image.png",
      ticket: "ticket-bootstrap-uppercase-image",
    },
    {
      kind: "image",
      source: "file:/home/node/.openclaw/media/outbound/bootstrap-authorityless-image.png",
      ticket: "ticket-bootstrap-authorityless-image",
    },
    {
      kind: "audio",
      source: "bootstrap-structured-audio.mp3",
      ticket: "ticket-bootstrap-structured-audio",
      structured: true,
    },
  ] as const)(
    "renders local assistant $kind through server metadata",
    async ({ kind, source: fixtureSource, ticket, ...options }) => {
      const source =
        "structured" in options
          ? `FILE:${path.join(mediaTempDirs.make("control-ui-audio-"), fixtureSource)}`
          : fixtureSource;
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const requestedMediaUrls: URL[] = [];
      const expectedSource = "structured" in options ? new URL(source).pathname : source;
      let mediaAllowed = true;

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(expectedSource);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          if (!mediaAllowed) {
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                available: false,
                reason: "Outside allowed folders",
                retryable: false,
                canAllow: true,
              }),
            });
            return;
          }
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              mediaTicket: ticket,
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          });
          return;
        }

        expect(url.searchParams.get("mediaTicket")).toBe(ticket);
        expect(request.headers().authorization).toBeUndefined();
        await route.fulfill(
          kind === "image"
            ? {
                contentType: "image/png",
                body: await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png")),
              }
            : {
                contentType: "audio/mpeg",
                body: createPlaybackMediaFixture("mp3"),
              },
        );
      });

      const gateway = await installMockGateway(page, {
        historyMessages: [
          kind === "image"
            ? {
                id: "assistant-bootstrap-local-image",
                role: "assistant",
                content: [{ type: "image", url: source, alt: "Local bootstrap image" }],
                timestamp: Date.now(),
              }
            : {
                id: "assistant-bootstrap-local-audio",
                role: "assistant",
                content:
                  "structured" in options
                    ? (await buildLocalWebchatAudioMessage(source)).content
                    : [{ type: "text", text: `Your recording\nMEDIA:${source}` }],
                timestamp: Date.now(),
              },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const media =
          kind === "image"
            ? page.getByAltText("Local bootstrap image")
            : page.locator("openclaw-chat-audio-player");
        await media.waitFor({
          state: "visible",
          timeout: 10_000,
        });
        await expect
          .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
          .toBeGreaterThanOrEqual(2);
        expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
        expect(
          requestedMediaUrls.slice(1).some((url) => url.searchParams.get("mediaTicket") === ticket),
        ).toBe(true);
        if (kind === "audio") {
          expect(
            await media.locator(".chat-assistant-attachment-card__download").getAttribute("href"),
          ).toContain(`mediaTicket=${ticket}`);
          await expect
            .poll(() =>
              media
                .locator("audio")
                .evaluate((element) => (element as HTMLMediaElement).readyState),
            )
            .toBeGreaterThanOrEqual(1);
        }
        expect(await page.getByText("Outside allowed folders").count()).toBe(0);

        if (kind === "image") {
          await expect
            .poll(() =>
              media.evaluate((element) =>
                element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
              ),
            )
            .toBe(180);
        }

        if ("revalidatePolicy" in options) {
          mediaAllowed = false;
          await gateway.emitGatewayEvent("config.changed", { hash: "workspace-protected" });
          await page.getByRole("button", { name: "Allow image", exact: true }).waitFor();
          expect(await media.count()).toBe(0);

          mediaAllowed = true;
          await gateway.emitGatewayEvent("config.changed", { hash: "workspace-unprotected" });
          await media.waitFor({ state: "visible" });
          await expect
            .poll(() => media.evaluate((element) => (element as HTMLImageElement).naturalWidth))
            .toBe(180);
          expect(await page.getByRole("button", { name: "Allow image", exact: true }).count()).toBe(
            0,
          );
          expect(
            requestedMediaUrls.filter((url) => url.searchParams.get("meta") === "1"),
          ).toHaveLength(3);
        }

        if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, `bootstrap-local-${kind}-${ticket}.png`),
          });
        }
        if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify({
              proof: "control-ui-local-media-bootstrap",
              kind,
              source,
              metadataAuthenticated: true,
              ticketScoped: true,
              rawRequestHasBearer: false,
              requests: requestedMediaUrls.map((url) => ({
                source: url.searchParams.get("source"),
                meta: url.searchParams.get("meta"),
                mediaTicket: url.searchParams.get("mediaTicket"),
              })),
            })}\n`,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

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
  ] as const)("keeps server-rejected $code media blocked", async ({ code, reason, source }) => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const requestedMediaUrls: URL[] = [];

    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requestedMediaUrls.push(url);
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.get("meta")).toBe("1");
      expect(request.headers().authorization).toBe("Bearer e2e-device-token");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ available: false, code, reason }),
      });
    });

    await installMockGateway(page, {
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
      expect(requestedMediaUrls).toHaveLength(1);
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
            metadataAuthenticated: true,
            rawMediaRequested: false,
            visibleReason: reason,
          })}\n`,
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
