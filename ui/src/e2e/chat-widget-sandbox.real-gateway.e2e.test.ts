// Synthetic authored content through the built Gateway, real RPC, and real browser sandbox.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createCanvasDocument } from "../../../src/canvas/documents.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { encodePngRgba } from "../../../src/media/png-encode.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
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
      const profileOptions = { env: owner.env };
      const profile = ensureGatewayOwnerProfile("Synthetic Viewer", profileOptions);
      const avatar = Buffer.from([70, 130, 190, 255]);
      const saved = setAvatar(profile.id, encodePngRgba(avatar, 1, 1), "image/png", profileOptions);
      if (!saved.ok) {
        throw new Error(`Synthetic avatar setup failed: ${saved.error.code}`);
      }
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

async function cliJson(
  owner: OpenClawTestInstance,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await owner.cli(["--no-color", ...args]);
  expect(result.code, args.slice(0, 3).join(" ")).toBe(0);
  expect(result.signal).toBeNull();
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

suite.define(() => {
  it("reads persisted Canvas bytes through an authenticated browser connection", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const sessionKey = "agent:main:widget-live-proof";
    const docId = "widget-live-proof";
    const session = await cliJson(owner, [
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
    const history = await cliJson(owner, [
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
    const handoff = await cliJson(owner, ["dashboard", "--json"]);
    expect(typeof handoff.browserUrl).toBe("string");
    const issued = new URL(String(handoff.browserUrl));
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
    url.hash = issued.hash;
    await suite.withPage(
      {
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        ...(captureEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 900 } } }
          : {}),
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
        if (captureEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "real-gateway-widget.png") });
          await writeFile(
            path.join(suite.artifactDir, "real-gateway-evidence.json"),
            JSON.stringify(
              { docId, a2uiDocId, canvasReads, opaque, sessionKey, gatewayPort: owner.port },
              null,
              2,
            ),
          );
        }
      },
    );
  });

  it("retains a real dashboard, article position, and chat draft across navigation and Settings", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const dashboardKey = "agent:main:daily-claw-retention";
    const chatKey = "agent:main:chat-navigation-retention";
    const widgetName = "daily-claw";
    const note = "Read the navigation story after lunch.";
    const draft = "Explain how retaining this dashboard preserves my reading position.";
    const rpc = (method: string, params: Record<string, unknown>) =>
      cliJson(owner, ["gateway", "call", method, "--params", JSON.stringify(params), "--json"]);
    const articleHtml = (edition: string) =>
      buildWidgetDocument(
        "The Daily Claw",
        `<style>
          body{padding:24px;font:16px system-ui;background:var(--surface);color:var(--text)}
          input{display:block;width:100%;box-sizing:border-box;padding:12px;margin:8px 0 20px}
          article{height:280px;overflow:auto;border:1px solid var(--border);padding:16px}
          article p{margin:0 0 24px;min-height:48px}
        </style>
        <h1>The Daily Claw</h1><p id="edition">${edition}</p>
        <label>Reading note <input aria-label="Reading note"></label>
        <article aria-label="Daily Claw article" tabindex="0">
          ${Array.from({ length: 30 }, (_, index) => `<p>Story ${index + 1}: Synthetic engineering news for the navigation retention proof.</p>`).join("")}
        </article>`,
      );
    await rpc("sessions.create", {
      key: dashboardKey,
      agentId: "main",
      label: "The Daily Claw",
    });
    await rpc("sessions.patch", { key: dashboardKey, boardFace: "dashboard" });
    const widgetParams = {
      sessionKey: dashboardKey,
      name: widgetName,
      title: "The Daily Claw",
      placement: { size: "full" },
    };
    await rpc("board.widget.put", {
      ...widgetParams,
      content: { kind: "html", html: articleHtml("Morning edition") },
    });
    const chat = await rpc("sessions.create", {
      key: chatKey,
      agentId: "main",
      label: "Navigation proof chat",
    });
    expect(typeof chat.sessionId).toBe("string");
    await appendTranscriptMessage(
      { agentId: "main", sessionKey: chatKey, sessionId: String(chat.sessionId), env: owner.env },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Synthetic session ready for navigation." }],
          timestamp: Date.now(),
        },
      },
    );
    const handoff = await cliJson(owner, ["dashboard", "--json"]);
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, dashboardKey, "dashboard"));
    url.hash = new URL(String(handoff.browserUrl)).hash;
    await suite.withPage(
      {
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        ...(captureEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const capture = async (filename: string) => {
          if (captureEnabled) {
            await page.screenshot({ path: path.join(suite.artifactDir, filename) });
          }
        };
        const sessionLink = (key: string) =>
          page.locator(
            `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
          );
        const response = await page.goto(url.toString());
        expect(response?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const board = page.locator("openclaw-board-view").first();
        const outer = board.locator(
          `.board-widget[data-widget-name="${widgetName}"] .board-widget__frame`,
        );
        const inner = outer.contentFrame().frameLocator("iframe");
        const readingNote = inner.getByRole("textbox", { name: "Reading note" });
        const article = inner.getByRole("article", { name: "Daily Claw article" });
        await readingNote.fill(note);
        await article.evaluate((element) => {
          element.scrollTop = 480;
        });
        const articleScrollTop = await article.evaluate((element) => element.scrollTop);
        expect(articleScrollTop).toBeGreaterThan(0);
        const originalFrame = await outer.elementHandle();
        const originalBoard = await board.elementHandle();
        if (!originalFrame || !originalBoard) {
          throw new Error("Daily Claw frame and board were not mounted");
        }
        const composer = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea",
        );
        await capture("01-daily-claw-warmed.png");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await sessionLink(chatKey).click();
          await composer.waitFor();
          await expect.poll(() => sessionLink(chatKey).getAttribute("aria-current")).toBe("page");
          if (attempt === 0) {
            await composer.fill(draft);
            await capture("02-chat-with-draft.png");
          } else {
            expect(await composer.inputValue()).toBe(draft);
          }
          expect(await originalFrame.evaluate((element) => element.isConnected)).toBe(true);
          await expect
            .poll(() => originalBoard.evaluate((element) => Reflect.get(element, "active")))
            .toBe(false);
          await sessionLink(dashboardKey).click();
          await readingNote.waitFor();
          expect(
            await outer.evaluate((element, previous) => element === previous, originalFrame),
          ).toBe(true);
          expect(await readingNote.inputValue()).toBe(note);
          expect(await article.evaluate((element) => element.scrollTop)).toBe(articleScrollTop);
        }
        await page.locator("openclaw-app-sidebar .sidebar-identity-card").click();
        await page
          .locator('openclaw-app-sidebar wa-dropdown-item[value="command:settings"]')
          .click();
        await page.locator(".settings-sidebar__back").waitFor();
        const parked = {
          frameConnected: await originalFrame.evaluate((element) => element.isConnected),
          boardActive: await originalBoard.evaluate((element) => Reflect.get(element, "active")),
        };
        await page.locator(".settings-sidebar__back").click();
        await readingNote.waitFor();
        // Retain the pre-fix failure's returned dashboard before checking its lost frame.
        await capture("03-daily-claw-after-settings.png");
        expect(
          await outer.evaluate((element, previous) => element === previous, originalFrame),
        ).toBe(true);
        expect(parked).toEqual({ frameConnected: true, boardActive: false });
        expect(await readingNote.inputValue()).toBe(note);
        expect(await article.evaluate((element) => element.scrollTop)).toBe(articleScrollTop);
        await sessionLink(chatKey).click();
        await composer.waitFor();
        expect(await composer.inputValue()).toBe(draft);
        await sessionLink(dashboardKey).click();
        await readingNote.waitFor();
        await rpc("board.widget.put", {
          ...widgetParams,
          content: {
            kind: "html",
            html: articleHtml("Afternoon edition: refreshed from the Gateway"),
          },
        });
        await inner
          .getByText("Afternoon edition: refreshed from the Gateway", { exact: true })
          .waitFor();
        await capture("04-daily-claw-refreshed.png");
      },
    );
  });
});
