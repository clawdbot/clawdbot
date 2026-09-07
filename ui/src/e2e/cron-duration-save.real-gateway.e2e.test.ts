// Browser edits persist through the normal built Gateway and independent CLI readback.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { CronJob } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI exact stagger with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-exact-stagger",
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: {
          enabled: false,
          failureAlert: {
            enabled: true,
            after: 5,
            cooldownMs: 7301,
            mode: "webhook",
            to: "https://alerts.example.test/global",
            includeSkipped: false,
          },
        },
      },
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

let catalogInstance: OpenClawTestInstance | undefined;
const catalogModels = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id, name: id },
];
const catalogSuite = createControlUiE2eSuite({
  name: "Automation catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "automation-catalog-publication",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: { defaults: { model: "fixture/anchor" } },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: catalogModels("retiring"),
            },
          },
        },
      },
    });
    catalogInstance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

catalogSuite.define(() => {
  it("keeps an open automation draft current through real catalog publication and read recovery", async () => {
    const owner = catalogInstance;
    if (!owner) {
      throw new Error("Catalog Gateway fixture was not started");
    }
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("cron", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const frames: unknown[] = [];
    const catalogRequests = new Set<string>();
    const commands: unknown[] = [];
    let rejectCatalogReplies = false;
    const rejected = new Set<string>();
    const publish = async (id: string) => {
      const args = [
        "config",
        "set",
        "models.providers.fixture.models",
        JSON.stringify(catalogModels(id)),
        "--strict-json",
        "--replace",
      ];
      const result = await owner.cli(args);
      commands.push({ args, ...result });
      expect(result.code, result.stderr).toBe(0);
    };
    try {
      await catalogSuite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
          recordVideo: { dir: catalogSuite.artifactDir },
        },
        async ({ page }) => {
          await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.type === "req" && frame.method !== "connect") {
                frames.push({ direction: "sent", frame });
                if (frame.method === "models.list" && typeof frame.id === "string") {
                  catalogRequests.add(frame.id);
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              const catalogReply = typeof frame.id === "string" && catalogRequests.has(frame.id);
              if (
                catalogReply ||
                frame.event === "config.changed" ||
                frame.event === "chat.metadata.changed"
              ) {
                frames.push({
                  direction: "received",
                  frame,
                  transportFailure: catalogReply && rejectCatalogReplies,
                });
              }
              // Inject failure after observing the real reply. Notifications and recovery
              // still come from the Gateway; no synthetic catalog or event replaces them.
              if (catalogReply && rejectCatalogReplies && typeof frame.id === "string") {
                rejected.add(frame.id);
                socket.send(
                  JSON.stringify({
                    type: "res",
                    id: frame.id,
                    ok: false,
                    error: { code: "UNAVAILABLE", message: "Catalog transport unavailable" },
                  }),
                );
              } else {
                socket.send(message);
              }
            });
          });
          await page.goto(url.toString());
          await waitForControlUiGatewayReady(page);
          await page.locator('[data-test-id="cron-new-task"]').click();
          await page.locator("#cron-name").fill("Retain this draft");
          await page.locator("#cron-payload-text").fill("Do not submit this draft");
          const picker = page.locator("#cron-payload-model-picker");
          await expect.poll(() => picker.locator('wa-option[value="retiring"]').count()).toBe(1);
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "initial.png") });
          await publish("published");
          await expect.poll(() => picker.locator('wa-option[value="published"]').count()).toBe(1);
          expect(await picker.locator('wa-option[value="retiring"]').count()).toBe(0);
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "published.png") });

          rejectCatalogReplies = true;
          await publish("held");
          await expect.poll(() => rejected.size).toBeGreaterThan(0);
          const error = page.locator(".cron-error-banner");
          await error.waitFor({ state: "visible" });
          expect(await error.textContent()).toContain("Catalog transport unavailable");
          expect(await picker.locator('wa-option[value="published"]').count()).toBe(1);
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "read-failure.png") });

          rejectCatalogReplies = false;
          await publish("recovered");
          await expect.poll(() => picker.locator('wa-option[value="recovered"]').count()).toBe(1);
          await error.waitFor({ state: "hidden" });
          expect(await page.locator("#cron-name").inputValue()).toBe("Retain this draft");
          expect(await page.locator("#cron-payload-text").inputValue()).toBe(
            "Do not submit this draft",
          );
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "recovered.png") });
        },
      );
    } finally {
      const redact = (text: string) =>
        text
          .replaceAll(owner.gatewayToken, "[synthetic token]")
          .replaceAll(owner.hookToken, "[synthetic token]");
      await fs.writeFile(
        path.join(catalogSuite.artifactDir, "publication.json"),
        redact(JSON.stringify({ frames, commands }, null, 2)),
      );
      await fs.writeFile(path.join(catalogSuite.artifactDir, "gateway.log"), redact(owner.logs()));
    }
  }, 120_000);
});

const requireRecord = createRequireRecord("record", "expected-object-value");
type CliJson = (args: string[]) => Promise<Record<string, unknown>>;
type ServedAsset = { path: string; status: number; sha256?: string; error?: string };
type CronPageEvidence = {
  page: Page;
  requests: Record<string, unknown>[];
  replies: Record<string, unknown>[];
  servedDocumentSha256: string;
  servedAssets: Promise<ServedAsset>[];
};

async function capture(page: Page, name: string, observed: unknown) {
  if (!captureEnabled) {
    return;
  }
  // The form is taller than the viewport. Preserve the flow's scroll to the
  // relevant field without resizing Chromium's recording surface.
  await fs.writeFile(
    path.join(suite.artifactDir, `${name}.png`),
    await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [
      page.locator("#cron-name"),
    ]),
  );
  await fs.writeFile(
    path.join(suite.artifactDir, `${name}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}

async function withGatewayCommands(artifactName: string, run: (cliJson: CliJson) => Promise<void>) {
  if (!instance) {
    throw new Error("Gateway fixture was not started");
  }
  const owner = instance;
  const commands: Record<string, unknown>[] = [];
  const redact = (text: string) =>
    text
      .replaceAll(owner.gatewayToken, "[synthetic token]")
      .replaceAll(owner.hookToken, "[synthetic token]");
  const cliJson: CliJson = async (args) => {
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
      expect(await cliJson(["automations", "status", "--json"])).toMatchObject({ enabled: false });
      await run(cliJson);
    },
    async () => {
      if (captureEnabled) {
        await fs.writeFile(
          path.join(suite.artifactDir, artifactName),
          `${JSON.stringify(commands, null, 2)}\n`,
        );
      }
    },
  );
}

function cronJobId(result: Record<string, unknown>): string {
  const job = "job" in result ? requireRecord(result.job) : result;
  if (typeof job.id !== "string") {
    throw new Error("Gateway did not return a job id");
  }
  return job.id;
}

async function withCronJobPage(
  cliJson: CliJson,
  jobId: string,
  run: (evidence: CronPageEvidence) => Promise<void>,
) {
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
      const requests: Record<string, unknown>[] = [];
      const replies: Record<string, unknown>[] = [];
      const servedAssets: Promise<ServedAsset>[] = [];
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
          const asset = { path: assetUrl.pathname.slice(marker + 1), status: response.status() };
          servedAssets.push(
            response.body().then(
              (body) => ({ ...asset, sha256: createHash("sha256").update(body).digest("hex") }),
              (error: unknown) => ({ ...asset, error: String(error) }),
            ),
          );
        });
      }
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const frame = requireRecord(JSON.parse(payload.toString()));
          if (
            frame.type === "req" &&
            (frame.method === "cron.update" || frame.method === "cron.add")
          ) {
            requests.push(frame);
          }
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = requireRecord(JSON.parse(payload.toString()));
          if (frame.type === "res" && requests.some(({ id }) => id === frame.id)) {
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
      await run({ page, requests, replies, servedDocumentSha256, servedAssets });
    },
  );
}

async function submitCronForm(
  evidence: CronPageEvidence,
  cliJson: CliJson,
  method: "cron.add" | "cron.update",
) {
  const { page, requests, replies } = evidence;
  const previousRequests = requests.length;
  await page.locator('[data-test-id="cron-submit"]').click();
  await expect.poll(() => requests.length).toBe(previousRequests + 1);
  const request = requireRecord(requests[previousRequests]);
  expect(request.method).toBe(method);
  await expect.poll(() => replies.some(({ id }) => id === request.id)).toBe(true);
  const reply = requireRecord(replies.find(({ id }) => id === request.id));
  expect(reply).toMatchObject({ ok: true });
  const id = cronJobId(requireRecord(method === "cron.add" ? reply.payload : request.params));
  if (method === "cron.add") {
    await page.locator('.cron-page[data-panel-mode="overview"]').waitFor();
    await page.locator(`[data-test-id="cron-row-${id}"]`).waitFor();
  } else {
    await expect.poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(false);
  }
  const stored = await cliJson(["automations", "get", id, "--json"]);
  expect(stored).toMatchObject({ id, enabled: false });
  return { request, reply, stored };
}

async function seedAlertJob(cliJson: CliJson, name: string, failureAlert: CronJob["failureAlert"]) {
  const result = await cliJson([
    "gateway",
    "call",
    "cron.add",
    "--params",
    JSON.stringify({
      name,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Synthetic paused failure-alert fixture" },
      delivery: { mode: "none" },
      failureAlert,
    }),
    "--json",
  ]);
  const id = cronJobId(result);
  const stored = await cliJson(["automations", "get", id, "--json"]);
  expect(stored).toMatchObject({
    id,
    name,
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
  });
  expect(stored.failureAlert).toEqual(failureAlert);
  return { id, stored };
}

async function pickerValue(picker: Locator) {
  return picker.evaluate((element) => {
    // SAFETY: Callers locate only registered wa-select controls rendered by the cron form.
    return (element as WaSelect).value;
  });
}

async function choosePicker(picker: Locator, value: string) {
  await picker.click();
  await picker.locator(`wa-option[value="${value}"]`).click();
  await expect.poll(() => pickerValue(picker)).toBe(value);
}

async function readAlertFields(page: Page) {
  const mode = page.locator("#cron-failure-alert-delivery-mode");
  return {
    after: await page.locator("#cron-failure-alert-after").inputValue(),
    cooldown: await page.locator("#cron-failure-alert-cooldown-seconds").inputValue(),
    mode: await pickerValue(mode),
    modeLabel: await mode.locator('input[role="combobox"]').inputValue(),
  };
}

suite.define(() => {
  it("configured duration precision: saves stagger through the real Gateway and CLI readback", async () => {
    await withGatewayCommands("real-gateway-commands.json", async (cliJson) => {
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
      const jobId = cronJobId(job);
      await withCronJobPage(cliJson, jobId, async (evidence) => {
        const { page, servedDocumentSha256, servedAssets } = evidence;
        await expect.poll(() => page.locator(".cron-detail-title").textContent()).toBe(job.name);
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
        const { request, stored } = await submitCronForm(evidence, cliJson, "cron.update");
        const reloadedStagger = await amount.inputValue();
        await amount.scrollIntoViewIfNeeded();
        await capture(page, "real-stagger-readback", {
          loadedStagger,
          submitted: request.params,
          stored,
          reloadedStagger,
          servedDocumentSha256,
          servedAssets: await Promise.all(servedAssets),
        });
        expect({ loadedStagger, submitted: request.params, stored, reloadedStagger }).toMatchObject(
          {
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
          },
        );
      });
    });
  });

  it("failure alert round trip: preserves partial policy through metadata save and clone", async () => {
    await withGatewayCommands("real-alert-preserve-commands.json", async (cliJson) => {
      const policy = { cooldownMs: 1_001, includeSkipped: true };
      const job = await seedAlertJob(cliJson, "Partial failure policy", policy);
      await withCronJobPage(cliJson, job.id, async (evidence) => {
        const { page, servedDocumentSha256, servedAssets } = evidence;
        await expect
          .poll(() => page.locator(".cron-detail-title").textContent())
          .toBe(job.stored.name);
        await page.locator("details.cron-advanced > summary").click();
        const loaded = await readAlertFields(page);
        await page.locator("#cron-failure-alert-cooldown-seconds").scrollIntoViewIfNeeded();
        await capture(page, "real-alert-loaded", {
          loaded,
          original: job.stored,
          servedDocumentSha256,
        });
        await page.locator("#cron-description").fill("Only metadata changed");
        const saved = await submitCronForm(evidence, cliJson, "cron.update");
        const savedFields = await readAlertFields(page);
        await capture(page, "real-alert-saved", { ...saved, savedFields });
        const menu = page.locator(".cron-detail-actions wa-dropdown");
        await menu.locator('button[slot="trigger"]').click();
        await menu.locator('wa-dropdown-item[value="clone"]').click();
        await page.locator("#cron-name").fill("Cloned partial failure policy");
        const cloned = await submitCronForm(evidence, cliJson, "cron.add");
        const cloneId = cronJobId(cloned.stored);
        await page.locator(`[data-test-id="cron-row-${cloneId}"]`).click();
        await expect
          .poll(() => page.locator(".cron-detail-title").textContent())
          .toBe(cloned.stored.name);
        await page.locator("details.cron-advanced > summary").click();
        const clonedFields = await readAlertFields(page);
        await page.locator("#cron-failure-alert-cooldown-seconds").scrollIntoViewIfNeeded();
        await capture(page, "real-alert-cloned", {
          ...cloned,
          clonedFields,
          servedDocumentSha256,
          servedAssets: await Promise.all(servedAssets),
        });
        const expectedFields = {
          after: "",
          cooldown: "1.001",
          mode: "",
          modeLabel: "Inherit global setting",
        };
        expect({ loaded, savedFields, clonedFields }).toEqual({
          loaded: expectedFields,
          savedFields: expectedFields,
          clonedFields: expectedFields,
        });
        expect(saved.stored.failureAlert).toEqual(policy);
        expect(cloned.stored.failureAlert).toEqual(policy);
        expect(saved.stored.schedule).toEqual(job.stored.schedule);
        expect(cloned.stored.schedule).toEqual(job.stored.schedule);
      });
    });
  });

  it("failure alert round trip: clears field overrides through the real picker", async () => {
    await withGatewayCommands("real-alert-clear-commands.json", async (cliJson) => {
      const job = await seedAlertJob(cliJson, "Clear failure policy", {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/job",
        accountId: "fixture-account",
        includeSkipped: true,
      });
      await withCronJobPage(cliJson, job.id, async (evidence) => {
        const { page, servedDocumentSha256, servedAssets } = evidence;
        await expect
          .poll(() => page.locator(".cron-detail-title").textContent())
          .toBe(job.stored.name);
        await page.locator("details.cron-advanced > summary").click();
        const loaded = await readAlertFields(page);
        await capture(page, "real-alert-clear-loaded", {
          loaded,
          original: job.stored,
          servedDocumentSha256,
        });
        await page.locator("#cron-failure-alert-after").fill("");
        await page.locator("#cron-failure-alert-cooldown-seconds").fill("");
        const deliveryMode = page.locator("#cron-failure-alert-delivery-mode");
        await deliveryMode.click();
        await capture(page, "real-alert-clear-choice", {
          options: await deliveryMode.locator("wa-option").evaluateAll((options) =>
            options.map((option) => ({
              value: option.getAttribute("value"),
              label: option.textContent?.trim(),
            })),
          ),
        });
        const inheritOption = deliveryMode.locator('wa-option[value=""]');
        await inheritOption.waitFor({ state: "visible" });
        expect(await inheritOption.textContent()).toContain("Inherit global setting");
        await inheritOption.click();
        await expect.poll(() => pickerValue(deliveryMode)).toBe("");
        await expect
          .poll(() => deliveryMode.locator('input[role="combobox"]').inputValue())
          .toBe("Inherit global setting");
        const cleared = await submitCronForm(evidence, cliJson, "cron.update");
        expect(cleared.request.params).toMatchObject({
          patch: { failureAlert: { after: null, cooldownMs: null, mode: null } },
        });
        expect(cleared.stored.failureAlert).toEqual({
          to: "https://alerts.example.test/job",
          accountId: "fixture-account",
          includeSkipped: true,
        });
        await capture(page, "real-alert-cleared", cleared);
        const policyMode = page.locator("#cron-failure-alert-mode");
        await choosePicker(policyMode, "inherit");
        const inherited = await submitCronForm(evidence, cliJson, "cron.update");
        expect(inherited.request.params).toMatchObject({ patch: { failureAlert: null } });
        expect(inherited.stored).not.toHaveProperty("failureAlert");
        await capture(page, "real-alert-inherited", inherited);
        await choosePicker(policyMode, "disabled");
        const disabled = await submitCronForm(evidence, cliJson, "cron.update");
        expect(disabled.stored.failureAlert).toBe(false);
        await capture(page, "real-alert-disabled", disabled);
        await choosePicker(policyMode, "custom");
        await page.locator("#cron-failure-alert-cooldown-seconds").fill("0");
        const zero = await submitCronForm(evidence, cliJson, "cron.update");
        expect(zero.stored.failureAlert).toEqual({ cooldownMs: 0 });
        await capture(page, "real-alert-zero", {
          ...zero,
          servedDocumentSha256,
          servedAssets: await Promise.all(servedAssets),
        });
      });
    });
  });

  it("clone payload policy: preserves public options through the real Gateway and CLI readback", async () => {
    await withGatewayCommands("real-clone-policy-commands.json", async (cliJson) => {
      for (const variant of [
        { name: "finite-cap", toolsAllow: ["read"], allowUnsafeExternalContent: false },
        { name: "empty-cap", toolsAllow: [], allowUnsafeExternalContent: true },
      ]) {
        const sourceName = `Synthetic clone ${variant.name} source`;
        const payload = {
          kind: "agentTurn" as const,
          message: "node -e \"console.log('synthetic clone fixture')\"",
          toolsAllow: variant.toolsAllow,
          fallbacks: [],
          lightContext: false,
          allowUnsafeExternalContent: variant.allowUnsafeExternalContent,
          timeoutSeconds: 0,
        };
        const created = await cliJson([
          "gateway",
          "call",
          "cron.add",
          "--params",
          JSON.stringify({
            name: sourceName,
            agentId: "main",
            enabled: false,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload,
            delivery: { mode: "none" },
          }),
          "--json",
        ]);
        const sourceId = cronJobId(created);
        const original = await cliJson(["automations", "get", sourceId, "--json"]);
        expect(original).toMatchObject({ id: sourceId, enabled: false });
        expect(original.payload).toEqual(payload);

        await withCronJobPage(cliJson, sourceId, async (evidence) => {
          const { page, servedDocumentSha256, servedAssets } = evidence;
          await expect
            .poll(() => page.locator(".cron-detail-title").textContent())
            .toBe(original.name);
          await capture(page, `real-clone-policy-${variant.name}-loaded`, {
            original,
            servedDocumentSha256,
          });
          const menu = page.locator(".cron-detail-actions wa-dropdown");
          await menu.locator('button[slot="trigger"]').click();
          await menu.locator('wa-dropdown-item[value="clone"]').click();
          await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
          await expect
            .poll(() => page.locator("#cron-name").inputValue())
            .toBe(`${sourceName} copy`);
          const cloneName = `Synthetic clone ${variant.name} copy`;
          await page.locator("#cron-name").fill(cloneName);
          const cloned = await submitCronForm(evidence, cliJson, "cron.add");
          const cloneId = cronJobId(cloned.stored);
          await page.locator(`[data-test-id="cron-row-${cloneId}"]`).click();
          await expect.poll(() => page.locator(".cron-detail-title").textContent()).toBe(cloneName);
          const originalAfter = await cliJson(["automations", "get", sourceId, "--json"]);
          await capture(page, `real-clone-policy-${variant.name}-readback`, {
            original,
            originalAfter,
            ...cloned,
            servedDocumentSha256,
            servedAssets: await Promise.all(servedAssets),
          });

          expect.soft(originalAfter, `${variant.name}: source unchanged`).toEqual(original);
          expect.soft(cloneId, `${variant.name}: new job identity`).not.toBe(sourceId);
          expect.soft(cloned.stored, `${variant.name}: new disabled task`).toMatchObject({
            name: cloneName,
            agentId: "main",
            enabled: false,
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
          });
          expect
            .soft(cloned.stored.schedule, `${variant.name}: exact schedule`)
            .toEqual(original.schedule);
          const params = requireRecord(cloned.request.params);
          const submittedPayload = requireRecord(params.payload);
          const storedPayload = requireRecord(cloned.stored.payload);
          for (const [field, value] of Object.entries(payload)) {
            expect
              .soft(submittedPayload[field], `${variant.name}: submitted ${field}`)
              .toEqual(value);
            expect.soft(storedPayload[field], `${variant.name}: stored ${field}`).toEqual(value);
          }
          for (const field of ["toolsAllowIsDefault", "externalContentSource"]) {
            expect
              .soft(submittedPayload, `${variant.name}: omitted ${field}`)
              .not.toHaveProperty(field);
          }
          for (const field of [
            "createdActor",
            "toolsAllowProvenance",
            "toolsAllowExecTarget",
            "toolsAllowExecTargetRequirement",
            "runtimeAuthority",
            "runtimeAuthorityRecoveryRequired",
            "skillLibrarySelections",
          ]) {
            expect.soft(params, `${variant.name}: omitted ${field}`).not.toHaveProperty(field);
          }
        });
      }
    });
  });
});
