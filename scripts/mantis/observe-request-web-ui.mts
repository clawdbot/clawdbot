#!/usr/bin/env node
// Runs only in the trusted, network-disabled observer container.
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { chromium, type WebSocketRoute } from "playwright";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  createControlUiMockSameOriginGatewayScript,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";

// A loopback origin preserves the browser secure-context contract without
// starting a server: the driver fulfills every HTTP request in this namespace.
const origin = "http://127.0.0.1:4173";
const socketUrl = "ws://127.0.0.1:4173/";
const [bundleArg, outputArg] = process.argv.slice(2);
if (!bundleArg || !outputArg || process.argv.length !== 4) {
  throw new Error("Usage: observe-request-web-ui.mts <bundle> <output>");
}
const bundle = await realpath(bundleArg);
const output = await realpath(outputArg);
const prompt = `Mantis request ${randomUUID()}`;
const reply = `Mantis reply ${randomUUID()}`;
const sessionKey = "agent:main:main";
const scenario = {
  historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Mantis ready." }] }],
};
// This realm never loads candidate HTML or scripts. The existing mock protocol
// stays reusable, but its request inventory is no longer in the candidate page.
const mock = new JSDOM("", { url: `${origin}/`, runScripts: "outside-only" });
new Script(createControlUiMockGatewayInitScript(scenario)).runInContext(
  mock.getInternalVMContext(),
);
const sockets = new Set<WebSocketRoute>();
let sendRequest: { id: string; params: unknown } | undefined;
let sendRequestCount = 0;
let resolveSend: (() => void) | undefined;
const sent = new Promise<void>((resolve) => {
  resolveSend = resolve;
});
let trafficBytes = 0;
let protocolError = false;
let captureArmed = false;
const browser = await chromium.launch({ chromiumSandbox: true });
const context = await browser.newContext({
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
  acceptDownloads: false,
});
const page = await context.newPage();
const diagnostics: string[] = [];
const recordDiagnostic = (text: string) => {
  if (diagnostics.length < 40) {
    diagnostics.push(text.slice(0, 500));
  }
};
page.on("pageerror", (error) => recordDiagnostic(error.message));
page.on("requestfailed", (request) =>
  recordDiagnostic(`Failed asset: ${new URL(request.url()).pathname}`),
);
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
try {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET") {
      await route.abort();
      return;
    }
    if (url.pathname === "/control-ui-config.json") {
      await route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) });
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname).slice(1);
    } catch {
      await route.abort();
      return;
    }
    // Only immutable exported regular files enter the browser; never execute
    // candidate server/config code in the observer or expose the harness tree.
    if (!relative || relative === "chat" || relative.startsWith("chat/")) {
      relative = "index.html";
    }
    if (
      relative.includes("\\") ||
      relative.split("/").some((part) => part === ".." || part === ".")
    ) {
      await route.abort();
      return;
    }
    const file = path.resolve(bundle, relative);
    try {
      const actual = await realpath(file);
      const stat = await lstat(file);
      if (
        !actual.startsWith(`${bundle}${path.sep}`) ||
        actual !== file ||
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024
      ) {
        throw new Error("unsafe asset");
      }
      await route.fulfill({
        body: await readFile(file),
        contentType: mime[path.extname(file)] ?? "application/octet-stream",
      });
    } catch {
      await route.abort();
    }
  });
  await context.routeWebSocket(/.*/, (route) => {
    if (route.url() !== socketUrl || sockets.size >= 4) {
      void route.close().catch(() => {});
      return;
    }
    sockets.add(route);
    const socket = new mock.window.WebSocket(socketUrl);
    const queued: string[] = [];
    socket.addEventListener("open", () => {
      for (const message of queued.splice(0)) {
        socket.send(message);
      }
    });
    socket.addEventListener("message", (event) => {
      const raw = String(event.data);
      route.send(raw);
      const frame = JSON.parse(raw);
      if (frame.type === "res" && frame.id === sendRequest?.id) {
        if (frame.ok !== true) {
          protocolError = true;
        }
        resolveSend?.();
      }
    });
    route.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      trafficBytes += Buffer.byteLength(raw);
      if (trafficBytes > 1024 * 1024 || raw.length > 64 * 1024) {
        protocolError = true;
        void route.close().catch(() => {});
        return;
      }
      try {
        const frame: unknown = JSON.parse(raw);
        if (
          captureArmed &&
          frame &&
          typeof frame === "object" &&
          "method" in frame &&
          frame.method === "chat.send" &&
          "id" in frame &&
          typeof frame.id === "string" &&
          "params" in frame
        ) {
          sendRequestCount += 1;
          sendRequest ??= { id: frame.id, params: frame.params };
          if (sendRequestCount > 1) {
            protocolError = true;
          }
        }
        if (socket.readyState === mock.window.WebSocket.OPEN) {
          socket.send(raw);
        } else {
          queued.push(raw);
        }
      } catch {
        protocolError = true;
        void route.close().catch(() => {});
      }
    });
    route.onClose(() => {
      socket.close();
      sockets.delete(route);
    });
  });
  await context.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
  await page.goto(`${origin}/chat`);
  await page.getByText("Mantis ready.", { exact: true }).waitFor({ timeout: 30_000 });
  captureArmed = true;
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sent,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("chat.send not observed")), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const params = sendRequest?.params;
  if (
    !params ||
    typeof params !== "object" ||
    !("idempotencyKey" in params) ||
    typeof params.idempotencyKey !== "string" ||
    params.idempotencyKey.length > 256 ||
    protocolError
  ) {
    throw new Error("Incomplete request observation");
  }
  // Route.send belongs to the driver, not a candidate-page global. The reply
  // is freshly chosen here and cannot be known before this observed request.
  const frame = JSON.stringify({
    type: "event",
    event: "chat",
    payload: {
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
      runId: params.idempotencyKey,
      sessionKey,
      state: "final",
    },
  });
  for (const socket of sockets) {
    socket.send(frame);
  }
  const rendered = page.locator(".chat-thread-inner").getByText(reply, { exact: true });
  await rendered.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000);
  if (sendRequestCount !== 1 || protocolError) {
    throw new Error("Unexpected chat.send count");
  }
  if (!(await rendered.isVisible())) {
    throw new Error("Final reply is no longer visible");
  }
  const actualText = await rendered.textContent();
  if (actualText !== reply) {
    throw new Error("Final reply does not match the observed response");
  }
  // Capture after the final assertion, unlike the legacy working-state image.
  await page.screenshot({ path: path.join(output, "final-reply.png"), fullPage: true });
  const records = {
    "chat-send.json": {
      expected: { deliver: false, message: prompt, sessionKey },
      actual: params,
      request_count: sendRequestCount,
    },
    "final-reply.json": { expected: reply, actual: actualText },
  };
  for (const [name, record] of Object.entries(records)) {
    await writeFile(path.join(output, name), `${JSON.stringify(record)}\n`, { flag: "wx" });
  }
  const inventory = [];
  for (const name of ["chat-send.json", "final-reply.json", "final-reply.png"]) {
    const bytes = await readFile(path.join(output, name));
    inventory.push({ path: name, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(
    path.join(output, "observer.json"),
    JSON.stringify({ schema: "mantis.web-ui-observer.v1", inventory }),
    { flag: "wx" },
  );
} catch (error) {
  await page.screenshot({ path: path.join(output, "incomplete.png") }).catch(() => {});
  await writeFile(
    path.join(output, "incomplete.json"),
    JSON.stringify({
      diagnostics,
      body: (
        (await page
          .locator("body")
          .textContent()
          .catch(() => "unavailable")) ?? "unavailable"
      ).slice(0, 4096),
    }),
  ).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
  mock.window.close();
}
