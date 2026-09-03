// Browser edits persist through the normal built Gateway and independent CLI readback.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI exact stagger with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-exact-stagger",
      config: { gateway: { controlUi: { enabled: true } } },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});
const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const requireRecord = createRequireRecord("record", "expected-object-value");

async function capture(page: Page, name: string, observed: unknown) {
  if (!captureEnabled) {
    return;
  }
  await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`), fullPage: true });
  await fs.writeFile(
    path.join(suite.artifactDir, `${name}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}

suite.define(() => {
  it("configured duration precision: saves stagger through the real Gateway and CLI readback", async () => {
    if (!instance) {
      throw new Error("Gateway fixture was not started");
    }
    const owner = instance;
    const commands: Record<string, unknown>[] = [];
    const redact = (text: string) =>
      text
        .replaceAll(owner.gatewayToken, "[synthetic token]")
        .replaceAll(owner.hookToken, "[synthetic token]");
    const cliJson = async (args: string[]) => {
      const result = await owner.cli(["--no-color", ...args]);
      commands.push({
        args,
        code: result.code,
        signal: result.signal,
        stderr: redact(result.stderr),
        stdout:
          args[0] === "dashboard" ? "[one-time browser handoff omitted]" : redact(result.stdout),
      });
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.signal).toBeNull();
      return requireRecord(JSON.parse(result.stdout));
    };
    await runQaGatewayFixture(
      async () => {
        expect(await cliJson(["automations", "status", "--json"])).toMatchObject({
          enabled: false,
        });
        const job = await cliJson([
          "automations",
          "add",
          "--name",
          "Browser stagger fixture",
          "--agent",
          "main",
          "--session",
          "main",
          "--system-event",
          "Synthetic paused browser fixture",
          "--disabled",
          "--cron",
          "0 * * * *",
          "--tz",
          "UTC",
          "--stagger",
          "1001ms",
          "--json",
        ]);
        expect(job).toMatchObject({ enabled: false, schedule: { staggerMs: 1_001 } });
        if (typeof job.id !== "string") {
          throw new Error("Gateway did not return a created job id");
        }
        const jobId = job.id;
        const handoff = await cliJson(["dashboard", "--json"]);
        expect(handoff.ok).toBe(true);
        if (typeof handoff.browserUrl !== "string") {
          throw new Error("Dashboard did not return its normal browser handoff");
        }
        const issued = new URL(handoff.browserUrl);
        const url = new URL("cron", issued);
        url.hash = issued.hash;
        url.searchParams.set("job", jobId);
        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1_280 },
            ...(captureEnabled
              ? { recordVideo: { dir: suite.artifactDir, size: { width: 1_280, height: 900 } } }
              : {}),
          },
          async ({ page }) => {
            const updates: Record<string, unknown>[] = [];
            const replies: Record<string, unknown>[] = [];
            const servedAssets: Promise<{
              path: string;
              status: number;
              sha256?: string;
              error?: string;
            }>[] = [];
            if (captureEnabled) {
              page.on("response", (response) => {
                const assetUrl = new URL(response.url());
                const marker = assetUrl.pathname.indexOf("/assets/");
                if (
                  assetUrl.origin !== issued.origin ||
                  marker < 0 ||
                  !/\.(?:js|css)$/u.test(assetUrl.pathname)
                ) {
                  return;
                }
                const asset = {
                  path: assetUrl.pathname.slice(marker + 1),
                  status: response.status(),
                };
                servedAssets.push(
                  response.body().then(
                    (body) => ({
                      ...asset,
                      sha256: createHash("sha256").update(body).digest("hex"),
                    }),
                    (error: unknown) => ({ ...asset, error: String(error) }),
                  ),
                );
              });
            }
            page.on("websocket", (socket) => {
              socket.on("framesent", ({ payload }) => {
                const frame = requireRecord(JSON.parse(payload.toString()));
                if (frame.type === "req" && frame.method === "cron.update") {
                  updates.push(frame);
                }
              });
              socket.on("framereceived", ({ payload }) => {
                const frame = requireRecord(JSON.parse(payload.toString()));
                if (frame.type === "res" && updates.some(({ id }) => id === frame.id)) {
                  replies.push(frame);
                }
              });
            });
            const document = await page.goto(url.toString());
            if (!document) {
              throw new Error("Gateway did not return the Control UI document");
            }
            expect(document.status()).toBe(200);
            const servedDocumentSha256 = createHash("sha256")
              .update(await document.body())
              .digest("hex");
            await waitForControlUiGatewayReady(page);
            expect(new URL(page.url()).hash.length).toBe(0);
            await expect
              .poll(() => page.locator(".cron-detail-title").textContent())
              .toBe(job.name);
            await page.locator("details.cron-advanced > summary").click();
            const amount = page.locator("#cron-stagger-amount");
            const loadedStagger = await amount.inputValue();
            await amount.scrollIntoViewIfNeeded();
            await capture(page, "real-stagger-loaded", {
              loadedStagger,
              originalSchedule: job.schedule,
              servedDocumentSha256,
            });
            await page.locator("#cron-cron-expr").fill("*/5 * * * *");
            await page.locator('[data-test-id="cron-submit"]').click();
            await expect.poll(() => replies.length).toBe(1);
            expect(replies[0]).toMatchObject({ ok: true });
            const stored = await cliJson(["automations", "get", jobId, "--json"]);
            await expect
              .poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled())
              .toBe(false);
            const reloadedStagger = await amount.inputValue();
            await amount.scrollIntoViewIfNeeded();
            await capture(page, "real-stagger-readback", {
              loadedStagger,
              submitted: updates[0]?.params,
              stored,
              reloadedStagger,
              servedDocumentSha256,
              servedAssets: await Promise.all(servedAssets),
            });
            expect({
              loadedStagger,
              submitted: updates[0]?.params,
              stored,
              reloadedStagger,
            }).toMatchObject({
              loadedStagger: "1.001",
              submitted: {
                id: jobId,
                patch: { enabled: false, schedule: { expr: "*/5 * * * *", staggerMs: 1_001 } },
              },
              stored: {
                id: jobId,
                enabled: false,
                schedule: { expr: "*/5 * * * *", staggerMs: 1_001 },
              },
              reloadedStagger: "1.001",
            });
          },
        );
      },
      async () => {
        if (captureEnabled) {
          await fs.writeFile(
            path.join(suite.artifactDir, "real-gateway-commands.json"),
            `${JSON.stringify(commands, null, 2)}\n`,
          );
        }
      },
    );
  });
});
