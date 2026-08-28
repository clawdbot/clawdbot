// Real official App and stdio MCP fixtures shared by conformance scenarios.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserContext, ConsoleMessage, Frame, Locator, Page } from "playwright";
import { expect } from "vitest";

const require = createRequire(import.meta.url);

export function observeMcpAppNetwork(
  page: Page,
  label: string,
  diagnostics: Array<Record<string, unknown>>,
) {
  page.on("request", (request) => {
    if (request.url().includes("mcp-app")) {
      diagnostics.push({
        host: label,
        atMs: Date.now(),
        event: "request",
        method: request.method(),
        pathname: new URL(request.url()).pathname,
      });
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("mcp-app")) {
      diagnostics.push({
        host: label,
        atMs: Date.now(),
        event: "response",
        status: response.status(),
        pathname: new URL(response.url()).pathname,
      });
    }
  });
  page.on("requestfailed", (request) =>
    diagnostics.push({
      host: label,
      atMs: Date.now(),
      event: "requestfailed",
      method: request.method(),
      pathname: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }),
  );
  page.on("pageerror", (error) =>
    diagnostics.push({
      host: label,
      atMs: Date.now(),
      event: "pageerror",
      message: error.message,
    }),
  );
}

export type McpAppFixtureEvent = {
  event: string;
  scenario: string;
  atMs: number;
  monotonicMs: number;
  method?: string;
  id?: string | number;
  requestId?: string | number;
  tool?: string;
  invocation?: number;
  aborted?: boolean;
};

async function readMcpAppFixtureEvents(eventsPath: string): Promise<McpAppFixtureEvent[]> {
  return (await fs.readFile(eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as McpAppFixtureEvent);
}

export function createMcpAppFixtureControl(controlPath: string, eventsPath: string) {
  return {
    readEvents: () => readMcpAppFixtureEvents(eventsPath),
    async configure(value: Record<string, unknown>): Promise<void> {
      const nextPath = controlPath + ".next";
      await fs.writeFile(nextPath, JSON.stringify(value));
      await fs.rename(nextPath, controlPath);
    },
  };
}

export async function openMcpAppProofContext(
  owner: Browser,
  openContexts: Set<BrowserContext>,
  { captureUiProof, proofDir }: { captureUiProof: boolean; proofDir: string },
): Promise<BrowserContext> {
  const context = await owner.newContext({
    permissions: ["local-network-access"],
    ...(captureUiProof
      ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
      : {}),
  });
  openContexts.add(context);
  return context;
}

export async function closeMcpAppProofContext(
  context: BrowserContext,
  openContexts: Set<BrowserContext>,
) {
  await context.close();
  openContexts.delete(context);
}

export function createMcpAppTeardownRecorder(proofDir: string, fixtureEventsPath: string) {
  const records: Array<{
    scenario: string;
    startedAtMs: number;
    observedAtMs: number;
    diagnostics: Array<{ event: string; atMs: number }>;
    events: McpAppFixtureEvent[];
  }> = [];
  return {
    records,
    async run(scenario: string, page: Page, app: Frame, teardown: () => Promise<void>) {
      const startedAtMs = Date.now();
      const diagnostics: Array<{ event: string; atMs: number }> = [];
      const onConsole = (message: ConsoleMessage) => {
        const event = message.text();
        if (
          event === "mcp-conformance-teardown-received" ||
          event === "mcp-conformance-teardown-saved"
        ) {
          diagnostics.push({ event, atMs: Date.now() });
        }
      };
      // Sandbox startup can detach other frames. Only this initialized App's
      // removal during the requested teardown establishes save-before-unmount.
      const onDetached = (frame: Frame) => {
        if (frame === app) {
          diagnostics.push({ event: "app-frame-detached", atMs: Date.now() });
        }
      };
      page.on("console", onConsole);
      page.on("framedetached", onDetached);
      try {
        await teardown();
        await expect.poll(() => page.frames().length).toBe(1);
      } finally {
        page.off("console", onConsole);
        page.off("framedetached", onDetached);
        records.push({
          scenario,
          startedAtMs,
          observedAtMs: Date.now(),
          diagnostics,
          events: (await readMcpAppFixtureEvents(fixtureEventsPath)).filter(
            (event) => event.scenario === scenario,
          ),
        });
        await fs.writeFile(
          path.join(proofDir, "graceful-teardown.json"),
          JSON.stringify(records, null, 2),
        );
      }
      expect(diagnostics.map(({ event }) => event)).toEqual([
        "mcp-conformance-teardown-received",
        "mcp-conformance-teardown-saved",
        "app-frame-detached",
      ]);
    },
  };
}

export async function requestStandaloneUrl(
  page: Page,
  { sessionKey, viewId }: { sessionKey: string; viewId: string },
): Promise<string> {
  return await page.evaluate(
    async (params) => {
      const client = Reflect.get(window, "mcpConformanceClient") as {
        request(method: string, params: unknown): Promise<unknown>;
      };
      const payload = (await client.request("mcp.app.view", {
        sessionKey: params.sessionKey,
        viewId: params.viewId,
      })) as {
        standaloneUrl: string;
      };
      return payload.standaloneUrl;
    },
    { sessionKey, viewId },
  );
}

export async function recordMcpAppHost(
  { proofDir, captureUiProof }: { proofDir: string; captureUiProof: boolean },
  page: Page,
  name: string,
) {
  const frames = [];
  for (const frame of page.frames()) {
    frames.push({
      url: frame.url().split("#")[0],
      state: await Promise.all([
        // Snapshot rendered text without waiting for an initializing frame's body.
        frame.locator("body").allInnerTexts(),
        frame.evaluate(() => ({
          html: document.body?.innerHTML.slice(0, 4000) ?? "",
          initialized: document.querySelector("#initialized")?.textContent ?? null,
          appTool: document.querySelector("#app-tool")?.textContent ?? null,
        })),
      ])
        .then(([texts, state]) => ({ text: texts[0]?.slice(0, 4000) ?? "", ...state }))
        .catch((error: unknown) => ({ detached: String(error) })),
    });
  }
  const errors = await page.locator(".error").allTextContents();
  const result = { atMs: Date.now(), frames, errors };
  await fs.writeFile(path.join(proofDir, name + ".json"), JSON.stringify(result, null, 2));
  if (captureUiProof) {
    await page.screenshot({ path: path.join(proofDir, name + ".png") });
  }
  return result;
}

export async function readMcpAppHistoryNavigation(page: Page) {
  return await page.evaluate(() => {
    // Non-restoration reasons may contain URLs; keep only reasons and child structure.
    const reasons = (value: unknown): unknown => {
      if (!value || typeof value !== "object") {
        return null;
      }
      return {
        reasons: Reflect.get(value, "reasons"),
        children: (Reflect.get(value, "children") ?? []).map(reasons),
      };
    };
    const entry = performance.getEntriesByType("navigation")[0];
    return {
      atMs: Date.now(),
      pathname: location.pathname,
      timeOrigin: performance.timeOrigin,
      pageShows: Reflect.get(window, "mcpConformancePageShows"),
      notRestoredReasons: entry ? reasons(Reflect.get(entry, "notRestoredReasons")) : null,
    };
  });
}

export async function mountControlUiHost(
  page: Page,
  {
    baseUrl,
    gatewayPort,
    authValue,
    sessionKey,
    viewId,
  }: {
    baseUrl: string;
    gatewayPort: number;
    authValue: string;
    sessionKey: string;
    viewId: string;
  },
): Promise<void> {
  await page.route(`${baseUrl}mcp-conformance`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main id="mount"></main>
<script type="module">
import { GatewayBrowserClient } from "/src/api/gateway.ts";
import "/src/components/mcp-app-view-registration.ts";
import { WIDGET_PROMPT_EVENT } from "/src/components/mcp-app-security.ts";
window.mcpConformanceGatewayBrowserClient = GatewayBrowserClient;
document.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
  window.mcpConformancePrompt = event.detail.text;
});
window.mcpConformanceUnmount = async () => {
  const mount = document.getElementById("mount");
  const view = window.mcpConformanceView;
  if (!mount || !view) return;
  const frame = view.shadowRoot?.querySelector("iframe");
  await view.teardown();
  if (frame?.isConnected) throw new Error("MCP App frame remained mounted");
  console.info("mcp-conformance-frame-detached");
  mount.replaceChildren();
};
</script>`,
    });
  });
  await page.goto(`${baseUrl}mcp-conformance`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => Reflect.get(window, "mcpConformanceGatewayBrowserClient") !== undefined,
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    async (params) => {
      const GatewayBrowserClient = Reflect.get(
        window,
        "mcpConformanceGatewayBrowserClient",
      ) as new (options: Record<string, unknown>) => {
        start(): void;
        request(method: string, params: unknown): Promise<unknown>;
      };
      let resolveHello!: () => void;
      let rejectHello!: (error: Error) => void;
      const connected = new Promise<void>((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
      });
      const client = new GatewayBrowserClient({
        url: params.gatewayUrl,
        token: params.authValue,
        onHello: () => resolveHello(),
        onClose: (info: { code: number; reason: string; error?: unknown; willRetry: boolean }) => {
          if (!info.willRetry) {
            rejectHello(new Error(`Gateway connection closed: ${JSON.stringify(info)}`));
          }
        },
      });
      client.start();
      await Promise.race([
        connected,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Gateway connection timed out")), 60_000);
        }),
      ]);
      const view = document.createElement("mcp-app-view");
      const root = document.documentElement;
      const themeListeners = new Set<() => void>();
      const setTheme = (theme: "light" | "dark") => {
        root.dataset.themeMode = theme;
        root.style.setProperty("--card", theme === "light" ? "#ffffff" : "#161920");
        root.style.setProperty("--text", theme === "light" ? "#403c35" : "#d4d4d8");
        for (const listener of themeListeners) {
          listener();
        }
      };
      setTheme("dark");
      Reflect.set(view, "context", {
        gateway: {
          snapshot: { client },
          connection: { gatewayUrl: params.gatewayUrl },
        },
        theme: {
          subscribe(listener: () => void) {
            themeListeners.add(listener);
            return () => themeListeners.delete(listener);
          },
        },
      });
      view.sessionKey = params.sessionKey;
      view.viewId = params.viewId;
      view.title = "Conformance app";
      document.getElementById("mount")?.appendChild(view);
      Object.assign(window, {
        mcpConformanceClient: client,
        mcpConformanceView: view,
        mcpConformanceSetTheme: setTheme,
      });
    },
    {
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      authValue,
      sessionKey,
      viewId,
    },
  );
}

export async function waitForText(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.textContent({ timeout: 500 })).toBe(expected);
}

export async function waitForTextContaining(
  locator: Locator,
  expected: string,
  present = true,
): Promise<void> {
  const assertion = expect.poll(() => locator.textContent());
  if (present) {
    await assertion.toContain(expected);
  } else {
    await assertion.not.toContain(expected);
  }
}

export function appHtml(appModuleUrl: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<style>
  :root {
    --color-background-primary: #f6f5f3;
    --color-text-primary: #17171a;
    --app-accent: #ff4f4f;
  }
  #theme-surface {
    background: var(--color-background-primary);
    color: var(--color-text-primary);
    border-left: 4px solid var(--app-accent);
  }
</style>
<div id="theme-surface">Host-themed surface</div>
<button id="arm-refresh">Arm catalog refresh</button>
<output id="arm-result"></output>
<button id="call-app">Call app tool</button>
<button id="call-expiring">Call with deadline</button>
<button id="cancel-call">Cancel app call</button>
<button id="call-model">Call model tool</button>
<button id="read-resource">Read resource</button>
<button id="update-context">Update context</button>
<button id="send-message">Send message</button>
<button id="request-teardown">Request teardown</button>
<output id="initialized">pending</output>
<output id="capabilities"></output>
<output id="ping"></output>
<output id="input"></output>
<output id="result"></output>
<output id="app-tool"></output>
<output id="model-tool"></output>
<output id="resource"></output>
<output id="context-update"></output>
<output id="message"></output>
<output id="teardown"></output>
<output id="isolation"></output>
<output id="host-theme"></output>
<output id="host-variables"></output>
<output id="computed-theme"></output>
<script type="module">
import {
  App,
  McpUiResourceTeardownResultSchema,
  applyDocumentTheme,
  applyHostStyleVariables,
} from ${JSON.stringify(appModuleUrl)};
const write = (id, value) => { document.getElementById(id).textContent = value; };
try { void window.top.document; write("isolation", "failed"); } catch { write("isolation", "isolated"); }
const app = new App({ name: "OpenClaw conformance fixture", version: "1.0.0" });
const applyHostContext = () => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  const surface = getComputedStyle(document.getElementById("theme-surface"));
  write("host-theme", context?.theme ?? "missing");
  write("host-variables", JSON.stringify(context?.styles?.variables ?? {}));
  write("computed-theme", JSON.stringify({
    background: surface.backgroundColor,
    color: surface.color,
    accent: surface.borderLeftColor,
  }));
};
app.onhostcontextchanged = applyHostContext;
app.ontoolinput = ({ arguments: args }) => write("input", JSON.stringify(args ?? {}));
app.ontoolresult = (value) => write("result", JSON.stringify(value.structuredContent ?? value));
app.onteardown = async () => {
  write("teardown", "received");
  console.info("mcp-conformance-teardown-received");
  const saved = await app.callServerTool({ name: "cleanup_save", arguments: {} });
  if (saved.structuredContent?.value !== "saved") throw new Error("Cleanup save was not accepted");
  write("teardown", "saved");
  console.info("mcp-conformance-teardown-saved");
  return {};
};
app.onerror = (error) => console.error("mcp-conformance-app", error);
document.getElementById("arm-refresh").onclick = async () => {
  write("arm-result", "pending");
  try {
    await app.callServerTool({ name: "arm_refresh", arguments: {} });
    write("arm-result", "armed");
  } catch (error) { write("arm-result", "denied:" + error); }
};
let activeCall;
const callAppTool = async (timeout) => {
  activeCall = new AbortController();
  write("app-tool", "pending");
  try {
    const value = await app.callServerTool({ name: "app_companion", arguments: {} }, {
      signal: activeCall.signal, ...(timeout === undefined ? {} : { timeout }),
    });
    write("app-tool", JSON.stringify(value.structuredContent ?? value));
  } catch (error) { write("app-tool", "denied:" + error); }
};
document.getElementById("call-app").onclick = () => callAppTool();
document.getElementById("call-expiring").onclick = () => callAppTool(3000);
document.getElementById("cancel-call").onclick = () => activeCall?.abort(new Error("fixture caller cancelled"));
document.getElementById("call-model").onclick = async () => {
  try { await app.callServerTool({ name: "model_only", arguments: {} }); write("model-tool", "allowed"); }
  catch (error) { write("model-tool", "denied:" + error); }
};
document.getElementById("read-resource").onclick = async () => {
  try {
    const value = await app.readServerResource({ uri: "data://conformance/value" });
    write("resource", JSON.stringify(value));
  } catch (error) { write("resource", "denied:" + error); }
};
document.getElementById("update-context").onclick = async () => {
  try {
    await app.updateModelContext({ content: [{ type: "text", text: "selected item 42" }] });
    write("context-update", "accepted");
  } catch (error) { write("context-update", "denied:" + error); }
};
document.getElementById("send-message").onclick = async () => {
  try {
    const value = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: "summarize selection" }],
    });
    write("message", value.isError ? "denied" : "accepted");
  } catch (error) { write("message", "denied:" + error); }
};
document.getElementById("request-teardown").onclick = () => app.requestTeardown();
await app.connect();
applyHostContext();
write("capabilities", JSON.stringify(app.getHostCapabilities() ?? {}));
write("ping", JSON.stringify(await app.request(
  { method: "ping", params: {} },
  McpUiResourceTeardownResultSchema,
)));
write("initialized", "ready");
</script>`;
}

export async function writeFixtureServer(
  serverPath: string,
  html: string,
  resourceOrigin: string,
  fixtureControlPath: string,
  fixtureEventsPath: string,
): Promise<void> {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const controlPath = ${JSON.stringify(fixtureControlPath)};
const eventsPath = ${JSON.stringify(fixtureEventsPath)};
const fixtureHtml = ${JSON.stringify(html)};
const control = () => JSON.parse(readFileSync(controlPath, "utf8"));
const record = (event, detail = {}) => appendFileSync(eventsPath, JSON.stringify({ event, atMs: Date.now(), monotonicMs: performance.now(), scenario: detail.scenario ?? control().scenario, ...detail }) + "\\n");
let delayNextList = false;
let invocations = 0;
const requests = new Map();
class ObservedStdioTransport extends StdioServerTransport {
  async start() {
    const onmessage = this.onmessage;
    this.onmessage = (message, extra) => {
      if (message.method && message.id !== undefined) requests.set(message.id, { method: message.method, tool: message.params?.name, scenario: control().scenario });
      const request = requests.get(message.id ?? message.params?.requestId);
      if (message.method) record("incoming", { method: message.method, id: message.id, requestId: message.params?.requestId, tool: message.params?.name, scenario: request?.scenario });
      onmessage?.(message, extra);
    };
    await super.start();
  }
  async send(message, options) {
    const request = requests.get(message.id);
    if (request?.method === "tools/list") {
      record("list-response-ready", { id: message.id, scenario: request.scenario });
      if (delayNextList) { delayNextList = false; await delay(8000); }
      record("list-response-send", { id: message.id, scenario: request.scenario });
    }
    await super.send(message, options);
    if (request) {
      record("response-written", { id: message.id, ...request, isError: Boolean(message.error) });
    }
  }
}
const appUri = "ui://conformance/app";
const server = new McpServer({ name: "mcp-app-conformance", version: "1.0.0" });
const show = server.tool("show", "Show the conformance app", async () => ({
  content: [{ type: "text", text: "initial-result" }],
  structuredContent: { value: "initial-result" },
}));
show.update({ _meta: { ui: { resourceUri: appUri } } });
const appOnly = server.tool("app_companion", "App-only companion", async (extra) => {
  const request = requests.get(extra.requestId);
  const config = control();
  const callDelayMs = config.callDelayMs ?? 0;
  const invocation = ++invocations;
  const detail = { invocation, requestId: extra.requestId, scenario: request?.scenario };
  const onAbort = () => record("tool-cancellation-observed", detail);
  extra.signal.addEventListener("abort", onAbort, { once: true });
  record("tool-start", detail);
  try {
    // Noncooperative work models an effect cancellation cannot undo.
    if (config.releasePath) {
      while (!existsSync(config.releasePath)) await delay(25);
    } else {
      await delay(callDelayMs, undefined, config.cooperative ? { signal: extra.signal } : undefined);
    }
    record("tool-complete", { ...detail, aborted: extra.signal.aborted });
  } catch (error) {
    if (extra.signal.aborted) record("tool-stopped", detail);
    throw error;
  } finally {
    extra.signal.removeEventListener("abort", onAbort);
  }
  return {
    content: [{ type: "text", text: "companion-called" }],
    structuredContent: { value: "companion-called", invocation },
  };
});
const arm = server.tool("arm_refresh", "Arm fixture catalog response delay", async (extra) => {
  const scenario = requests.get(extra.requestId)?.scenario;
  delayNextList = true;
  await server.server.sendToolListChanged();
  record("notification-sent", { scenario, requestId: extra.requestId });
  return { content: [{ type: "text", text: "armed" }] };
});
arm.update({ _meta: { ui: { visibility: ["app"] } } });
appOnly.update({ _meta: { ui: { visibility: ["app"] } } });
const cleanupSave = server.tool("cleanup_save", "Save App state before unmount", async (extra) => {
  const scenario = requests.get(extra.requestId)?.scenario;
  record("cleanup-save", { scenario, requestId: extra.requestId });
  return { content: [{ type: "text", text: "saved" }], structuredContent: { value: "saved" } };
});
cleanupSave.update({ _meta: { ui: { visibility: ["app"] } } });
const modelOnly = server.tool("model_only", "Model-only tool", async () => ({
  content: [{ type: "text", text: "model-called" }],
}));
modelOnly.update({ _meta: { ui: { visibility: ["model"] } } });
server.registerResource("conformance_app", appUri, { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: "text/html;profile=mcp-app",
    text: fixtureHtml,
    _meta: { ui: { csp: { resourceDomains: [${JSON.stringify(resourceOrigin)}] } } },
  }] }));
server.registerResource("conformance_data", "data://conformance/value", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: "resource-ok" }],
}));
await server.connect(new ObservedStdioTransport());
`,
    { encoding: "utf8", mode: 0o755 },
  );
}

export async function findAppFrame(page: Page): Promise<Frame> {
  try {
    await expect
      .poll(
        async () => {
          for (const frame of page.frames()) {
            if ((await frame.locator("#initialized").count()) > 0) {
              return 1;
            }
          }
          return 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const component = await page.evaluate(() => {
      const view = document.querySelector("mcp-app-view");
      return {
        exists: Boolean(view),
        error: view?.shadowRoot?.querySelector(".error")?.textContent ?? null,
        shadow: view?.shadowRoot?.textContent ?? null,
      };
    });
    throw new Error(
      `MCP App inner frame not found: ${JSON.stringify({
        component,
        frames: page.frames().map((frame) => {
          const frameUrl = frame.url();
          if (!frameUrl) {
            return "";
          }
          const url = URL.parse(frameUrl);
          if (!url) {
            return "[invalid frame URL]";
          }
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.href;
        }),
      })}`,
      { cause: error },
    );
  }
  let frame: Frame | undefined;
  for (const candidate of page.frames()) {
    if ((await candidate.locator("#initialized").count()) > 0) {
      frame = candidate;
      break;
    }
  }
  if (!frame) {
    throw new Error("MCP App inner frame not found");
  }
  await waitForText(frame.locator("#initialized"), "ready");
  return frame;
}
