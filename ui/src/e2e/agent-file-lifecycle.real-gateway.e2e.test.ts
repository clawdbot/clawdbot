// Real Gateway proof for browser agent selection and persisted workspace saves.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  captureAgentFileScreenshot,
  selectAgentFileWorkspace,
} from "./agent-file-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

let catalogInstance: OpenClawTestInstance;
let inventoryModel = "inventory-before";
const inventoryRequests: string[] = [];
const refreshInventoryArgs = [
  "gateway",
  "call",
  "models.list",
  "--json",
  "--params",
  JSON.stringify({ agentId: "main", view: "all", refresh: true }),
];
const catalogModels = (id: string) => [
  { id: "anchor", name: "Anchor" },
  { id: "selected", name: "Selected" },
  { id, name: id },
];
const catalogSuite = createControlUiE2eSuite({
  name: "Agents catalog publication with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const inventory = createServer((request, response) => {
      inventoryRequests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/show"
            ? {
                capabilities: ["completion", "tools"],
                model_info: { "llama.context_length": 32768 },
              }
            : { models: [{ name: inventoryModel, capabilities: ["completion", "tools"] }] },
        ),
      );
    });
    const inventoryPort = await getFreePort();
    await new Promise<void>((resolve) => {
      inventory.listen(inventoryPort, "127.0.0.1", resolve);
    });
    catalogInstance = await createOpenClawTestInstance({
      name: "agents-catalog-publication",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: {
          defaults: {
            model: "fixture/anchor",
            modelPolicy: { allow: ["fixture/*", "ollama/*"] },
          },
        },
        models: {
          providers: {
            ollama: { api: "ollama", baseUrl: `http://127.0.0.1:${inventoryPort}` },
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
    const close = async () => {
      await Promise.all([
        catalogInstance.cleanup(),
        new Promise<void>((resolve, reject) => {
          inventory.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
    };
    try {
      await catalogInstance.startGateway();
      const initialInventory = await catalogInstance.cli(refreshInventoryArgs);
      expect(initialInventory.code, initialInventory.stderr).toBe(0);
      expect(initialInventory.stdout).toContain("inventory-before");
      return {
        baseUrl: `http://127.0.0.1:${catalogInstance.port}/`,
        close,
      };
    } catch (error) {
      await writeFile(path.join(catalogSuite.artifactDir, "startup.log"), catalogInstance.logs());
      await writeFile(
        path.join(catalogSuite.artifactDir, "inventory-requests.json"),
        JSON.stringify(inventoryRequests),
      );
      await close();
      throw error;
    }
  },
});

catalogSuite.define(() => {
  it("refreshes an open Agents editor after catalog publication without losing drafts", async () => {
    const owner = catalogInstance;
    const requireRecord = createRequireRecord("record", "expected-object-value");
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("settings/agents/main/overview", browserUrl);
    url.hash = new URL(browserUrl).hash;
    const frames: unknown[] = [];
    const commands: unknown[] = [];
    const metadataRequests = new Set<string>();
    const mutations: string[] = [];
    let rejectMetadata = false;
    let holdMetadata = false;
    const heldMetadata: Array<() => void> = [];
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
          viewport: { height: 1000, width: 1440 },
          recordVideo: { dir: catalogSuite.artifactDir },
        },
        async ({ page }) => {
          await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.type === "req" && frame.method !== "connect") {
                frames.push({ direction: "sent", frame });
                if (frame.method === "chat.metadata" && typeof frame.id === "string") {
                  metadataRequests.add(frame.id);
                }
                if (
                  ["config.set", "config.patch", "config.apply", "agents.update"].includes(
                    String(frame.method),
                  )
                ) {
                  mutations.push(String(frame.method));
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              const metadataReply = typeof frame.id === "string" && metadataRequests.has(frame.id);
              if (
                metadataReply ||
                frame.event === "config.changed" ||
                frame.event === "chat.metadata.changed"
              ) {
                frames.push({
                  direction: "received",
                  frame,
                  transportFailure: metadataReply && rejectMetadata,
                });
              }
              if (metadataReply && holdMetadata) {
                heldMetadata.push(() => socket.send(message));
              } else if (metadataReply && rejectMetadata) {
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
          const editor = page.locator("openclaw-agents-page");
          const picker = editor.locator(".model-picker__select");
          await expect
            .poll(() => picker.locator('wa-option[value="fixture/retiring"]').count())
            .toBe(1);
          await editor
            .locator(".agent-identity-editor__fields input[maxlength='64']")
            .fill("Keep this identity draft");
          await picker.click();
          await picker.locator('wa-option[value="fixture/selected"]').click();
          const fallbacks = editor.locator(".agent-chip-input input");
          await fallbacks.fill("fixture/anchor");
          await fallbacks.press("Enter");
          const selected = () => picker.evaluate((element) => (element as WaSelect).value);
          await expect.poll(selected).toBe("fixture/selected");
          await expect.poll(() => mutations.length).toBeGreaterThan(0);
          await expect
            .poll(async () => {
              const result = await owner.cli([
                "config",
                "get",
                "agents.entries.main.model",
                "--json",
              ]);
              return result.code === 0 ? JSON.parse(result.stdout) : null;
            })
            .toEqual({ primary: "fixture/selected", fallbacks: ["fixture/anchor"] });
          const writesBeforePublication = [...mutations];
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "initial.png") });

          await publish("published");
          await expect
            .poll(() => picker.locator('wa-option[value="fixture/published"]').count())
            .toBe(1);
          expect(await picker.locator('wa-option[value="fixture/retiring"]').count()).toBe(0);
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "published.png") });

          inventoryModel = "inventory-after";
          const refreshed = await owner.cli(refreshInventoryArgs);
          commands.push({ args: refreshInventoryArgs, ...refreshed });
          expect(refreshed.code, refreshed.stderr).toBe(0);
          expect(refreshed.stdout).toContain("inventory-after");
          await expect
            .poll(() => picker.locator('wa-option[value="ollama/inventory-after"]').count())
            .toBe(1);
          expect(await picker.locator('wa-option[value="ollama/inventory-before"]').count()).toBe(
            0,
          );

          holdMetadata = true;
          inventoryModel = "inventory-held";
          commands.push(await owner.cli(refreshInventoryArgs));
          await expect.poll(() => heldMetadata.length).toBeGreaterThan(0);
          holdMetadata = false;
          inventoryModel = "inventory-latest";
          commands.push(await owner.cli(refreshInventoryArgs));
          await expect
            .poll(() => picker.locator('wa-option[value="ollama/inventory-latest"]').count())
            .toBe(1);
          for (const release of heldMetadata) {
            release();
          }
          await page.screenshot({
            path: path.join(catalogSuite.artifactDir, "latest-publication.png"),
          });
          expect(await picker.locator('wa-option[value="ollama/inventory-latest"]').count()).toBe(
            1,
          );
          expect(await picker.locator('wa-option[value="ollama/inventory-held"]').count()).toBe(0);

          rejectMetadata = true;
          await publish("held");
          const error = editor
            .getByRole("alert")
            .filter({ hasText: "Catalog transport unavailable" });
          await error.waitFor({ state: "visible" });
          expect(await picker.locator('wa-option[value="fixture/published"]').count()).toBe(1);
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "read-failure.png") });

          rejectMetadata = false;
          await publish("recovered");
          await expect
            .poll(() => picker.locator('wa-option[value="fixture/recovered"]').count())
            .toBe(1);
          await error.waitFor({ state: "hidden" });
          expect(await selected()).toBe("fixture/selected");
          expect(
            await editor
              .locator(".agent-identity-editor__fields input[maxlength='64']")
              .inputValue(),
          ).toBe("Keep this identity draft");
          expect(await editor.locator(".agent-chip-input .chip").textContent()).toContain(
            "fixture/anchor",
          );
          expect(mutations).toEqual(writesBeforePublication);
          const persistedModel = await owner.cli([
            "config",
            "get",
            "agents.entries.main.model",
            "--json",
          ]);
          commands.push(persistedModel);
          expect(persistedModel.code, persistedModel.stderr).toBe(0);
          expect(JSON.parse(persistedModel.stdout)).toEqual({
            primary: "fixture/selected",
            fallbacks: ["fixture/anchor"],
          });
          const persisted = await owner.cli(["config", "get", "agents.defaults.model", "--json"]);
          commands.push(persisted);
          expect(persisted.code, persisted.stderr).toBe(0);
          expect(JSON.parse(persisted.stdout)).toBe("fixture/anchor");
          await page.screenshot({ path: path.join(catalogSuite.artifactDir, "recovered.png") });
        },
      );
    } finally {
      const redact = (value: string) =>
        value
          .replaceAll(owner.gatewayToken, "[synthetic token]")
          .replaceAll(owner.hookToken, "[synthetic token]");
      await writeFile(
        path.join(catalogSuite.artifactDir, "publication.json"),
        redact(JSON.stringify({ frames, commands, inventoryRequests }, null, 2)),
      );
      await writeFile(path.join(catalogSuite.artifactDir, "gateway.log"), redact(owner.logs()));
    }
  }, 120_000);
});

suite.define(() => {
  it("reads and saves the selected agent workspace through an isolated Gateway", async (context) => {
    let fixture: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    await suite.runScenario(context, {
      retainedState: () => fixture?.root,
      close: async () => {
        const server = await gateway;
        await server?.close({ reason: "agent file lifecycle e2e cleanup" });
      },
      release: async () => {
        await fixture?.cleanup();
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        const state = await createOpenClawTestState({
          label: "control-ui-agent-files",
          layout: "home",
          env: {
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        fixture = state;
        signal.throwIfAborted();
        const mainWorkspace = state.path("workspace-main");
        const writerWorkspace = state.path("workspace-writer");
        // A failed setup must not leave sibling writes running beyond cleanup.
        for (const [workspace, content] of [
          [mainWorkspace, "# Real main instructions\n"],
          [writerWorkspace, "# Real writer instructions\n"],
        ] as const) {
          signal.throwIfAborted();
          await mkdir(workspace, { recursive: true });
          signal.throwIfAborted();
          await writeFile(path.join(workspace, "AGENTS.md"), content, "utf8");
        }
        signal.throwIfAborted();
        await state.writeConfig({
          agents: {
            defaults: { workspace: mainWorkspace },
            entries: {
              main: { default: true, workspace: mainWorkspace },
              writer: { workspace: writerWorkspace },
            },
          },
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
          },
        });
        signal.throwIfAborted();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        signal.throwIfAborted();
        gateway = startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();

        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
          },
          async ({ page }) => {
            const url = new URL("settings/agents/main/files", suite.server.baseUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
            await page.goto(url.toString());
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
            const editor = page.locator(".agent-file-textarea");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");

            await selectAgentFileWorkspace(page, "writer");
            await expect.poll(() => editor.inputValue()).toBe("# Real writer instructions\n");

            await selectAgentFileWorkspace(page, "main");
            await expect.poll(() => editor.inputValue()).toBe("# Real main instructions\n");
            await editor.fill("# Saved through real Gateway\n");
            const save = page.locator(".agent-file-actions").getByRole("button", { name: "Save" });
            await save.click();
            await expect.poll(() => save.isDisabled()).toBe(true);
            await expect
              .poll(() => readFile(path.join(mainWorkspace, "AGENTS.md"), "utf8"))
              .toBe("# Saved through real Gateway\n");
            await captureAgentFileScreenshot(page, "07-real-gateway-main-save.png");
          },
        );
      },
    });
  });
});
