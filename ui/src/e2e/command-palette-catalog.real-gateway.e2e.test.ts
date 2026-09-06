import fs from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const models = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id, name: id },
];
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Command Palette catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "palette-catalog-publication",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: { model: "fixture/anchor" },
          list: [
            { id: "main", identity: { name: "Main fixture" } },
            { id: "reviewer", identity: { name: "Reviewer fixture" } },
          ],
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: models("palette-retiring"),
            },
          },
        },
      },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("refreshes open search after publication and retains results through a failed read", async () => {
    const handoff = await instance.cli(["dashboard", "--json"]);
    expect(handoff.code).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const frames: unknown[] = [];
    const commands: unknown[] = [];
    const catalogRequests = new Set<string>();
    const catalogParams: unknown[] = [];
    let rejectCatalogReplies = false;
    const publish = async (id: string) => {
      const args = [
        "config",
        "set",
        "models.providers.fixture.models",
        JSON.stringify(models(id)),
        "--strict-json",
        "--replace",
      ];
      const result = await instance.cli(args);
      commands.push({ args, ...result });
      expect(result.code, result.stderr).toBe(0);
    };
    try {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.routeWebSocket(`ws://127.0.0.1:${instance.port}/**`, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.type === "req" && frame.method !== "connect") {
                frames.push({ direction: "sent", frame });
                if (frame.method === "models.list" && typeof frame.id === "string") {
                  catalogRequests.add(frame.id);
                  catalogParams.push(frame.params);
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
              if (catalogReply && rejectCatalogReplies) {
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
          await page.goto(browserUrl);
          await waitForControlUiGatewayReady(page);
          await page.keyboard.press("Control+K");
          const input = page.locator(".cmd-palette__input");
          await input.fill("palette-");
          const retiring = page.getByRole("option", {
            name: "palette-retiring fixture",
            exact: true,
          });
          const published = page.getByRole("option", {
            name: "palette-published fixture",
            exact: true,
          });
          await retiring.waitFor({ state: "visible" });
          await page.screenshot({ path: path.join(suite.artifactDir, "initial.png") });
          await publish("palette-published");
          await expect.poll(() => published.count()).toBe(1);
          expect(await retiring.count()).toBe(0);
          await page.screenshot({ path: path.join(suite.artifactDir, "published.png") });

          rejectCatalogReplies = true;
          await publish("palette-held");
          const status = page
            .locator(".cmd-palette [role=status]")
            .filter({ hasText: "Model search unavailable" });
          await status.waitFor({ state: "visible" });
          expect(await published.count()).toBe(1);
          await page.screenshot({ path: path.join(suite.artifactDir, "read-failure.png") });
          rejectCatalogReplies = false;
          await input.fill("palette-held");
          const recovered = page.getByRole("option", { name: "palette-held fixture", exact: true });
          await recovered.waitFor({ state: "visible" });
          await status.waitFor({ state: "hidden" });
          await input.press("Enter");
          await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
          await page.screenshot({ path: path.join(suite.artifactDir, "recovered.png") });
          await page.goBack();
          rejectCatalogReplies = true;
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.getByRole("button", { name: /Switch agent/ }).click();
          await sidebar
            .getByRole("menuitemradio", { name: "Reviewer fixture", exact: true })
            .click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/reviewer");
          const requestsBeforeOpen = catalogParams.length;
          await page.keyboard.press("Control+K");
          await input.fill("palette");
          await status.waitFor({ state: "visible" });
          expect(catalogParams.length).toBeGreaterThan(requestsBeforeOpen);
          expect(catalogParams.at(-1)).toEqual({
            view: "configured",
            agentId: "reviewer",
            preparedOnly: true,
          });
          expect(await recovered.count()).toBe(0);
          await page.screenshot({
            path: path.join(suite.artifactDir, "selected-agent-failure.png"),
          });
          rejectCatalogReplies = false;
          await input.fill("palette-held");
          await recovered.waitFor({ state: "visible" });
          await status.waitFor({ state: "hidden" });
        },
      );
    } finally {
      const redact = (text: string) =>
        text
          .replaceAll(instance.gatewayToken, "[synthetic token]")
          .replaceAll(instance.hookToken, "[synthetic token]");
      await fs.writeFile(
        path.join(suite.artifactDir, "publication.json"),
        redact(JSON.stringify({ frames, commands }, null, 2)),
      );
      await fs.writeFile(path.join(suite.artifactDir, "gateway.log"), redact(instance.logs()));
    }
  }, 120_000);
});
