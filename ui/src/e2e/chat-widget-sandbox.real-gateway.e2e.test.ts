// Synthetic authored content through the built Gateway, real RPC, and real browser sandbox.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createCanvasDocument } from "../../../src/canvas/documents.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI widget sandbox with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-widget-sandbox",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      },
      env: { OPENCLAW_SKIP_CANVAS_HOST: "0", OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
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

suite.define(() => {
  it("reads persisted Canvas bytes through an authenticated browser connection", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const sessionKey = "agent:main:widget-live-proof";
    const docId = "widget-live-proof";
    const cliJson = async (args: string[]): Promise<Record<string, unknown>> => {
      const result = await owner.cli(["--no-color", ...args]);
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.signal).toBeNull();
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const session = await cliJson([
      "gateway",
      "call",
      "sessions.create",
      "--params",
      JSON.stringify({ key: sessionKey, agentId: "main", label: "Synthetic widget proof" }),
      "--json",
    ]);
    expect(session.ok).toBe(true);
    expect(typeof session.sessionId).toBe("string");
    await createCanvasDocument(
      {
        id: docId,
        kind: "html_bundle",
        title: "Live widget proof",
        cspSandbox: "scripts",
        surface: "assistant_message",
        entrypoint: {
          type: "html",
          value: buildWidgetDocument(
            "Live widget proof",
            `<style>body{padding:24px;font:16px system-ui;background:var(--surface);color:var(--text)}
              input{padding:12px;background:var(--surface-raised);color:var(--text);border:1px solid var(--border)}</style>
              <h1>Live widget proof</h1><p>Loaded from this isolated Gateway's persisted Canvas document.</p>
              <label>Local note <input aria-label="Local note"></label>`,
          ),
        },
      },
      { stateDir: owner.stateDir },
    );
    const a2uiDocId = `${docId}-a2ui`;
    const a2uiBundlePath = "/__openclaw__/a2ui/a2ui-v0.9.bundle.js";
    const a2uiBoot = JSON.stringify({
      messages: [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "main",
            catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
          },
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "main",
            components: [
              { id: "root", component: "Column", children: ["title"] },
              { id: "title", component: "Text", text: "A2UI live proof" },
            ],
          },
        },
      ],
      actionTier: "state",
    }).replaceAll("<", "\\u003c");
    await createCanvasDocument(
      {
        id: a2uiDocId,
        kind: "html_bundle",
        title: "A2UI live proof",
        cspSandbox: "scripts",
        surface: "assistant_message",
        entrypoint: {
          type: "html",
          value: buildWidgetDocument(
            "A2UI live proof",
            `<script>globalThis.openclawA2UIBoot=${a2uiBoot};</script><style>html,body{height:100%;overflow:hidden;background:transparent}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host><script>(()=>{const match=location.pathname.match(/^\\/__openclaw__\\/cap\\/[^/]+/u);const script=document.createElement("script");script.src=(match?.[0]??"")+${JSON.stringify(a2uiBundlePath)};document.head.appendChild(script);})();</script>`,
            { scriptOrigins: ["'self'"] },
          ),
        },
      },
      { stateDir: owner.stateDir },
    );
    const content = [
      {
        type: "text",
        text: `The synthetic widgets are ready.\n[embed ref="${docId}" title="Live widget proof" height="320" /]\n[embed ref="${a2uiDocId}" title="A2UI live proof" height="200" /]`,
      },
    ];
    await appendTranscriptMessage(
      {
        agentId: "main",
        sessionKey,
        sessionId: String(session.sessionId),
        env: owner.env,
      },
      {
        message: {
          role: "assistant",
          content,
          timestamp: Date.now(),
        },
      },
    );
    const history = await cliJson([
      "gateway",
      "call",
      "chat.history",
      "--params",
      JSON.stringify({ sessionKey, agentId: "main" }),
      "--json",
    ]);
    expect(history.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content })]),
    );
    const handoff = await cliJson(["dashboard", "--json"]);
    expect(typeof handoff.browserUrl).toBe("string");
    const issued = new URL(String(handoff.browserUrl));
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
    url.hash = issued.hash;
    await suite.withPage(
      {
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 900 } },
      },
      async ({ page }) => {
        const canvasReads: unknown[] = [];
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const request = JSON.parse(payload.toString()) as { method?: string; params?: unknown };
            if (request.method === "canvas.document.view") {
              canvasReads.push(request.params);
            }
          });
        });
        const response = await page.goto(url.toString());
        expect(response?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const outer = page
          .locator("openclaw-canvas-widget-view .chat-tool-card__preview-frame")
          .first();
        const inner = outer.contentFrame().frameLocator("iframe");
        await inner.getByRole("heading", { name: "Live widget proof" }).waitFor();
        await inner
          .getByRole("textbox", { name: "Local note" })
          .fill("Persisted bytes, isolated UI");
        const a2uiOuter = page
          .locator("openclaw-canvas-widget-view .chat-tool-card__preview-frame")
          .nth(1);
        const a2uiInner = a2uiOuter.contentFrame().frameLocator("iframe");
        await a2uiInner.getByText("A2UI live proof", { exact: true }).waitFor();
        expect(canvasReads).toHaveLength(2);
        expect(canvasReads).toEqual(expect.arrayContaining([{ docId }, { docId: a2uiDocId }]));
        expect(await outer.getAttribute("src")).toContain("/mcp-app-sandbox");
        const opaque = await inner.locator("body").evaluate(() => {
          try {
            void window.top?.document;
            return false;
          } catch {
            return true;
          }
        });
        expect(opaque).toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "real-gateway-widget.png") });
        await writeFile(
          path.join(suite.artifactDir, "real-gateway-evidence.json"),
          JSON.stringify(
            { docId, a2uiDocId, canvasReads, opaque, sessionKey, gatewayPort: owner.port },
            null,
            2,
          ),
        );
      },
    );
  });
});
