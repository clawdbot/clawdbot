// Real Chromium, HTTP authentication, and sandbox isolation around mocked Gateway data.
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI authenticated widget sandbox",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:widget-sandbox-proof";
const documentId = "widget-sandbox-proof";
const documentPath = `/__openclaw__/canvas/documents/${documentId}/index.html`;
const widgetName = `canvas-${documentId}`;
const boardPath = `/__openclaw__/board/${encodeURIComponent(sessionKey)}/${widgetName}/index.html`;
const sourceAuthorization = "Bearer synthetic-widget-source-credential";

function widgetDocument(): string {
  return buildWidgetDocument(
    "Community pulse",
    `<style>
      body{margin:0;padding:24px;background:var(--surface);color:var(--text);font:15px system-ui}
      h1{margin:10px 0;font-size:26px}p{line-height:1.5;color:var(--text-muted)}
      .eyebrow{font-size:11px;letter-spacing:.15em;color:var(--accent)}
      label{display:block;margin-top:20px}input{box-sizing:border-box;width:100%;padding:10px;
        margin:8px 0 16px;background:var(--surface-raised);color:var(--text);border:1px solid var(--border);border-radius:6px}
      button{padding:10px 12px;margin:0 6px 8px 0;border:1px solid var(--border);
        background:var(--surface-raised);color:var(--text);border-radius:6px;cursor:pointer}
      output{display:block;margin-top:12px}.details{height:540px;padding-top:20px}
    </style>
    <div class="eyebrow">SYNTHETIC COMMUNITY DASHBOARD</div>
    <h1>Community pulse</h1>
    <p>The same interactive document is available in chat and in the dashboard.</p>
    <label>Local note<input aria-label="Local note" placeholder="State stays in this widget"></label>
    <button id="refresh">Refresh via chat</button><button id="details">Toggle details</button>
    <button id="data">Try dashboard data</button><button id="record">Record state</button>
    <output id="result" aria-label="Widget result">Ready</output>
    <div id="extra" class="details" hidden>Additional community details</div>
    <script>
      document.querySelector('#refresh').onclick=()=>window.openclaw.prompt.send('Refresh the synthetic dashboard');
      document.querySelector('#details').onclick=()=>{const extra=document.querySelector('#extra');extra.hidden=!extra.hidden;};
      document.querySelector('#data').onclick=async()=>{try{await window.openclaw.data.read('private-dashboard');
        document.querySelector('#result').textContent='Unexpected data access';}
        catch{document.querySelector('#result').textContent='Dashboard data is unavailable in chat';}};
      document.querySelector('#record').onclick=async()=>{await window.openclaw.state.emit({clicked:true});
        document.querySelector('#result').textContent='State recorded';};
    </script>`,
  );
}

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Widget proof server did not bind a TCP port"));
      } else {
        resolve(address.port);
      }
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startProtectedSource(html: string) {
  const sourceRequests: Array<{ authorized: boolean; destination?: string }> = [];
  const boardRequests: string[] = [];
  const omittedHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", suite.server.baseUrl);
      if (url.pathname === documentPath) {
        const authorized = request.headers.authorization === sourceAuthorization;
        const destination = request.headers["sec-fetch-dest"];
        sourceRequests.push({
          authorized,
          ...(typeof destination === "string" ? { destination } : {}),
        });
        response.writeHead(authorized ? 200 : 302, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          ...(!authorized ? { Location: "/widget-login" } : {}),
        });
        response.end(authorized ? html : "Authentication required");
        return;
      }
      if (url.pathname === "/widget-login") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        });
        response.end("<!doctype html><title>Synthetic sign-in</title>Sign in to view this widget.");
        return;
      }
      if (url.pathname === boardPath) {
        const ticket = url.searchParams.get("bt") ?? "";
        boardRequests.push(ticket);
        const authorized = ticket === "ticket" || ticket === "renewed-ticket";
        response.writeHead(authorized ? 200 : 401, {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(authorized ? html : "Invalid widget ticket");
        return;
      }
      const upstream = await fetch(url, { headers: { Accept: request.headers.accept ?? "*/*" } });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!omittedHeaders.has(name)) {
          response.setHeader(name, value);
        }
      }
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  const port = await listen(server);
  return { server, baseUrl: `http://127.0.0.1:${port}/`, sourceRequests, boardRequests };
}

suite.define(() => {
  it("loads protected widgets in chat and preserves isolated interactive frames", async () => {
    const html = widgetDocument();
    const sandboxServer = createSandboxHostHttpServer();
    const sandboxPort = await listen(sandboxServer);
    const proxy = await startProtectedSource(html);
    const sandboxUrl = buildSandboxHostPath({ blockDescendantFrames: true });
    const snapshot = {
      sessionKey,
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        {
          name: widgetName,
          tabId: "main",
          title: "Community pulse",
          contentKind: "html",
          sizeW: 12,
          sizeH: 5,
          position: 0,
          grantState: "none",
          revision: 1,
          frameUrl: `${new URL(proxy.baseUrl).origin}${boardPath}?bt=ticket`,
          viewTicket: "ticket",
          viewTicketTtlMs: 1_200_000,
          viewGeneration: "0123456789abcdef0123456789abcdef",
          sandboxUrl,
          sandboxPort,
        },
      ],
    };
    try {
      const unauthenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
        redirect: "manual",
      });
      expect(unauthenticated.status).toBe(302);
      const authenticated = await fetch(new URL(documentPath, proxy.baseUrl), {
        headers: { Authorization: sourceAuthorization },
      });
      expect(await authenticated.text()).toBe(html);

      await suite.withPage(
        {
          viewport: { width: 1600, height: 1000 },
          serviceWorkers: "block",
          permissions: ["local-network-access"],
          recordVideo: { dir: suite.artifactDir, size: { width: 1600, height: 1000 } },
        },
        async ({ page }) => {
          const storageKey = controlUiBundledSettingsStorageKey(proxy.baseUrl);
          await page.addInitScript(
            ({ key, session }) => {
              const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
              settings.boardSessionViews = { [session]: { activeTabId: "main" } };
              localStorage.setItem(key, JSON.stringify(settings));
            },
            { key: storageKey, session: sessionKey },
          );
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "board.get",
              "board.event",
              "canvas.document.view",
            ],
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `[embed ref="${documentId}" title="Community pulse" height="460" /]`,
                  },
                ],
                timestamp: Date.now(),
              },
            ],
            methodResponses: {
              "canvas.document.view": { html, sandboxUrl, sandboxPort },
              "board.get": snapshot,
              "board.event": { ok: true, appended: true },
            },
          });
          await page.goto(controlUiSessionUrl(proxy.baseUrl, sessionKey, "dashboard"));
          const outer = page.locator(".chat-tool-card__preview-frame");
          await outer.waitFor();
          const boardOuter = page.locator(".board-widget__frame");
          const board = boardOuter.contentFrame().frameLocator("iframe");
          await board.getByRole("heading", { name: "Community pulse" }).waitFor();
          // This capture also records the old blocked direct iframe during red proof.
          await page.screenshot({ path: path.join(suite.artifactDir, "01-auth-gated-widget.png") });
          const inline = outer.contentFrame().frameLocator("iframe");
          await inline.getByRole("heading", { name: "Community pulse" }).waitFor();
          expect(
            proxy.sourceRequests.filter(({ destination }) => destination !== undefined),
          ).toEqual([]);
          expect((await gateway.getRequests("canvas.document.view"))[0]?.params).toEqual({
            docId: documentId,
          });
          expect(proxy.boardRequests).toEqual(["ticket"]);
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-inline-and-sidebar.png"),
          });

          const isolation = await inline.locator("body").evaluate(() => {
            const denied = (read: () => unknown) => {
              try {
                read();
                return false;
              } catch {
                return true;
              }
            };
            return {
              topDom: denied(() => window.top?.document),
              wrapperDom: denied(() => window.parent.document),
              cookies: denied(() => document.cookie),
              localStorage: denied(() => window.localStorage),
            };
          });
          expect(isolation).toEqual({
            topDom: true,
            wrapperDom: true,
            cookies: true,
            localStorage: true,
          });
          await inline.getByRole("button", { name: "Try dashboard data" }).click();
          await inline.getByText("Dashboard data is unavailable in chat").waitFor();
          expect(await gateway.getRequests("board.data.read")).toEqual([]);

          const retainedFrame = await outer.elementHandle();
          const retainedBoardFrame = await boardOuter.elementHandle();
          const note = inline.getByRole("textbox", { name: "Local note" });
          const boardNote = board.getByRole("textbox", { name: "Local note" });
          await note.fill("State survives rerenders");
          await boardNote.fill("Dashboard state survives swaps");
          for (const region of ["main", "side"]) {
            await page.locator(".chat-panel-swap").click();
            await expect
              .poll(() => page.locator('[data-panel-slot="dashboard"]').getAttribute("data-region"))
              .toBe(region);
            expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await retainedBoardFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
            expect(await note.inputValue()).toBe("State survives rerenders");
            expect(await boardNote.inputValue()).toBe("Dashboard state survives swaps");
          }
          const originalHeight = (await outer.boundingBox())?.height ?? 0;
          await inline.getByRole("button", { name: "Toggle details" }).click();
          await expect
            .poll(async () => (await outer.boundingBox())?.height ?? 0)
            .toBeGreaterThan(originalHeight + 400);
          expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
          expect(await note.inputValue()).toBe("State survives rerenders");
          await inline.getByRole("button", { name: "Toggle details" }).click();

          await inline.getByRole("button", { name: "Refresh via chat" }).click();
          const sent = asRecord((await gateway.waitForRequest("chat.send")).params);
          expect(sent).toMatchObject({
            sessionKey,
            message: "Refresh the synthetic dashboard",
            idempotencyKey: expect.any(String),
          });
          const runId = String(sent.idempotencyKey);
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            seq: 1,
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Refreshing community signals…" }],
            },
          });
          await page
            .getByRole("paragraph")
            .filter({ hasText: /^Refreshing community signals…$/u })
            .waitFor();
          await gateway.emitChatFinal({
            sessionKey,
            runId,
            text: "Synthetic dashboard refreshed.",
          });
          await page
            .getByRole("paragraph")
            .filter({ hasText: /^Synthetic dashboard refreshed\.$/u })
            .waitFor();
          expect(await retainedFrame?.evaluate((frame) => frame.isConnected)).toBe(true);
          expect(await note.inputValue()).toBe("State survives rerenders");
          expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);

          await board.getByRole("button", { name: "Record state" }).click();
          await board.getByText("State recorded", { exact: true }).waitFor();
          expect((await gateway.getRequests("board.event"))[0]?.params).toEqual({
            ticket: "ticket",
            payload: { clicked: true },
          });
          await page.emulateMedia({ colorScheme: "dark" });
          await expect
            .poll(() =>
              inline.locator("html").evaluate((root) => getComputedStyle(root).colorScheme),
            )
            .toBe("dark");
          await expect
            .poll(() =>
              board.locator("html").evaluate((root) => getComputedStyle(root).colorScheme),
            )
            .toBe("dark");
          expect(await note.inputValue()).toBe("State survives rerenders");
          await outer.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(suite.artifactDir, "03-interactive-state-retained.png"),
          });
          await writeFile(
            path.join(suite.artifactDir, "evidence.json"),
            JSON.stringify(
              {
                isolation,
                sourceRequests: proxy.sourceRequests,
                boardRequests: proxy.boardRequests,
                canvasReads: (await gateway.getRequests("canvas.document.view")).length,
                prompt: sent.message,
                localNote: await note.inputValue(),
                dashboardLocalNote: await boardNote.inputValue(),
                retainedFrame: await retainedFrame?.evaluate((frame) => frame.isConnected),
                retainedDashboardFrame: await retainedBoardFrame?.evaluate(
                  (frame) => frame.isConnected,
                ),
              },
              null,
              2,
            ),
          );
        },
      );
    } finally {
      await runQaGatewayFixture(
        () => close(proxy.server),
        () => close(sandboxServer),
      );
    }
  });
});
