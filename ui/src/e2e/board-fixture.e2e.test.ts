import { spawn, type ChildProcessByStdio } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.ts";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeStandaloneMockServer =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;

type FixtureServer = {
  child: FixtureProcess;
  url: string;
  output: () => string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startFixtureServer(fixture?: "attachments"): Promise<FixtureServer> {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/__fixtures/board/`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/control-ui-mock-dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      ...(fixture ? ["--fixture", fixture] : []),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const mockServer = { child, url, output: () => output };

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Control UI mock server exited before startup\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return mockServer;
      }
    } catch {}
    await delay(100);
  }

  await stopFixtureServer(mockServer);
  throw new Error(`timed out waiting for Control UI mock server\n${output}`);
}

async function stopFixtureServer(server: FixtureServer | undefined): Promise<void> {
  if (server) {
    await stopChildProcess(server.child, 5_000);
  }
}

function colorChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function colorLuminance(color: string): number {
  const match = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!match) {
    throw new Error(`unsupported computed color: ${color}`);
  }
  if (match[4] !== undefined && Number(match[4]) !== 1) {
    throw new Error(`transparent computed color requires compositing: ${color}`);
  }
  const channels = match.slice(1, 4).map(Number);
  return (
    0.2126 * colorChannelToLinear(channels[0]!) +
    0.7152 * colorChannelToLinear(channels[1]!) +
    0.0722 * colorChannelToLinear(channels[2]!)
  );
}

function colorContrast(foreground: string, background: string): number {
  const lighter = Math.max(colorLuminance(foreground), colorLuminance(background));
  const darker = Math.min(colorLuminance(foreground), colorLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function openWidgetMenu(page: Page): Promise<void> {
  const widget = page.locator('[data-test-id="board-widget"]').first();
  await widget.focus();
  await widget.locator(".board-widget__menu-trigger").click();
  await page.locator(".board-widget__menu[open]").waitFor();
}

async function readMenuColors(page: Page): Promise<{ background: string; foreground: string }> {
  return page.evaluate(() => {
    const dropdown = document.querySelector(".board-widget__menu");
    const item = dropdown?.querySelector("wa-dropdown-item:not(.board-widget__menu-danger)");
    const menu = dropdown?.shadowRoot?.querySelector('[part~="menu"]');
    if (!(item instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error("board fixture menu did not expose its surface and first item");
    }
    return {
      background: getComputedStyle(menu).backgroundColor,
      foreground: getComputedStyle(item).color,
    };
  });
}

let browser: Browser;
let fixtureServer: FixtureServer;

async function requestPreviewGateway(
  page: Page,
  requests: Array<{ method: string; params?: unknown }>,
): Promise<unknown[]> {
  return page.evaluate((batch) => {
    const app = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
      "openclaw-app",
    );
    const client = app?.runtime?.context.gateway.snapshot.client;
    if (!client) {
      throw new Error("Preview Gateway client is unavailable");
    }
    return Promise.all(batch.map(({ method, params }) => client.request(method, params)));
  }, requests);
}

describeStandaloneMockServer("standalone Control UI mock server", () => {
  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => {
        await browser?.close();
      },
      () => stopFixtureServer(fixtureServer),
    );
  });

  it("correlates concurrent caretaker replies with their original requests", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString());
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
      const replies = await requestPreviewGateway(page, [
        { method: "openclaw.chat", params: { sessionId: "delayed", message: "hello" } },
        { method: "openclaw.chat", params: { sessionId: "welcome" } },
      ]);
      expect(replies).toMatchObject([
        { sessionId: "delayed", reply: expect.stringContaining("demo turn 0") },
        { sessionId: "welcome", reply: expect.stringContaining("system caretaker") },
      ]);
    } finally {
      await page.close();
    }
  });

  it("keeps renamed preview groups authoritative across reads and reloads", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString());
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
      await requestPreviewGateway(page, [
        { method: "sessions.groups.rename", params: { name: "Research", to: "Reviewed" } },
      ]);
      for (const reload of [false, true]) {
        if (reload) {
          await page.reload();
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        }
        expect(await requestPreviewGateway(page, [{ method: "sessions.groups.list" }])).toEqual([
          { groups: [{ name: "Reviewed", position: 0 }], sectionOrder: [] },
        ]);
      }
    } finally {
      await page.close();
    }
  });

  it.each([
    { task: 1, user: "Map the run-status", assistant: "Tracing task events" },
    { task: 2, user: "Audit the gateway", assistant: "Comparing requester" },
  ])(
    "serves background task $task through both chat entry points",
    async ({ task, user, assistant }) => {
      const page = await browser.newPage();
      try {
        await page.goto(new URL("/chat", fixtureServer.url).toString());
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        const sessionKey = `agent:openclaw-mock:subagent:mock-task-${task}`;
        const [description] = (await requestPreviewGateway(page, [
          { method: "sessions.describe", params: { key: sessionKey } },
        ])) as Array<{ session: { sessionId: string } }>;
        expect(description).toMatchObject({
          session: { key: sessionKey, sessionId: expect.any(String) },
        });
        const replies = await requestPreviewGateway(
          page,
          ["chat.history", "chat.startup"].map((method) => ({
            method,
            params: { sessionKey },
          })),
        );
        for (const reply of replies) {
          expect(reply).toMatchObject({
            sessionId: description!.session.sessionId,
            sessionInfo: description!.session,
            messages: [
              { role: "user", content: [{ text: expect.stringContaining(user) }] },
              {
                role: "assistant",
                content: [{ text: expect.stringContaining(assistant) }],
              },
            ],
          });
        }
      } finally {
        await page.close();
      }
    },
  );

  it("keeps the main preview run active when hydrating canonical session metadata", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString());
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
      expect(
        await requestPreviewGateway(page, [
          { method: "chat.startup", params: { sessionKey: "agent:main:main" } },
        ]),
      ).toMatchObject([
        {
          sessionInfo: { hasActiveRun: true, status: "running", activeRunIds: ["mock-plan-run"] },
          inFlightRun: { runId: "mock-plan-run" },
        },
      ]);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
    } finally {
      await page.close();
    }
  });

  it("keeps generated search-session metadata in the canonical fixture catalog", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString());
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
      const replies = await requestPreviewGateway(
        page,
        ["telegram", "claude"].map((search) => ({
          method: "sessions.list",
          params: { search },
        })),
      );
      expect(replies).toMatchObject([
        {
          sessions: expect.arrayContaining([
            expect.objectContaining({ label: "Telegram investigation 001", model: "gpt-5.6-luna" }),
          ]),
        },
        {
          sessions: expect.arrayContaining([
            expect.objectContaining({
              label: "Model search result 001",
              model: "claude-sonnet-4-6",
            }),
          ]),
        },
      ]);
    } finally {
      await page.close();
    }
  });

  it("keeps synthetic avatar requests on the preview origin across reloads", async () => {
    const context = await browser.newContext();
    const previewOrigin = new URL(fixtureServer.url).origin;
    const externalRequests: string[] = [];
    const avatarRequests: string[] = [];
    try {
      // A failing regression must never reach a developer's real Gateway.
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (new URL(url).origin !== previewOrigin) {
          externalRequests.push(url);
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/users/presence-riley/avatar") {
          avatarRequests.push(request.url());
        }
      });
      await page.goto(`${previewOrigin}/chat/main?skillLibrary=collaborator&nav=collapsed`);
      for (const reload of [false, true]) {
        if (reload) {
          avatarRequests.length = 0;
          await page.reload();
        }
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        await expect.poll(() => avatarRequests.length).toBeGreaterThan(0);
        expect([...new Set(avatarRequests.map((url) => new URL(url).origin))]).toEqual([
          previewOrigin,
        ]);
        expect(externalRequests).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });

  it("keeps profile and presence HTTP inside the standalone mock", async () => {
    const artifacts = createControlUiE2eArtifactDir("standalone-network-isolation");
    const origin = new URL(fixtureServer.url).origin;
    const escaped: string[] = [];
    const requests: string[] = [];
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: artifacts },
    });
    await runQaGatewayFixture(
      async () => {
        // A pre-fix tripwire protects the operator, but every rejected escape still fails the test.
        await context.route("**/*", (route) => {
          const url = route.request().url();
          requests.push(url);
          if (new URL(url).origin !== origin) {
            escaped.push(url);
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${origin}/chat`, { waitUntil: "networkidle" });
        await page.getByText("OpenClaw work checkout", { exact: true }).click();
        await page.getByRole("button", { name: "Write a message to send." }).waitFor();
        await page.screenshot({ path: path.join(artifacts, "chat.png") });
        await page.goto(`${origin}/profile`, { waitUntil: "networkidle" });
        await expect
          .poll(() => page.getByRole("textbox", { name: "Display name", exact: true }).inputValue())
          .toBe("Riley");
        await page.screenshot({ path: path.join(artifacts, "profile.png") });
        await page.goto(`${origin}/focus/terminal`, { waitUntil: "networkidle" });
        const terminal = page.locator("openclaw-terminal-panel");
        await terminal.locator(".tabstrip-tab.is-live").waitFor();
        await terminal.locator(".tp-host canvas").waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(artifacts, "terminal.png") });
        expect(
          escaped,
          "standalone mock must not attempt Gateway HTTP or external requests",
        ).toEqual([]);
      },
      () =>
        writeFile(
          path.join(artifacts, "network.json"),
          JSON.stringify({ origin, escaped, requests }, null, 2),
        ),
      () => context.close(),
    );
  });

  it("blocks native egress before connecting while preserving local HMR and frame resources", async () => {
    const artifacts = createControlUiE2eArtifactDir("standalone-network-probes");
    const received: string[] = [];
    let connections = 0;
    const sink = createHttpServer((req, res) => {
      received.push(req.url ?? "/");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end("unexpected egress");
    });
    sink.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => {
      sink.listen(0, "127.0.0.1", resolve);
    });
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    const origin = new URL(fixtureServer.url).origin;
    let context: BrowserContext | undefined;
    const escaped: string[] = [];
    const outcomes: Record<string, unknown> = {};
    await runQaGatewayFixture(
      async () => {
        context = await browser.newContext({ serviceWorkers: "block" });
        // Allow the synthetic sink through: the browser/server boundary, not the
        // test router, must prevent TCP connections. Still protect other origins.
        await context.route("**/*", (route) => {
          const target = new URL(route.request().url()).origin;
          if (target === origin || target === sinkUrl) {
            return route.continue();
          }
          escaped.push(route.request().url());
          return route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        const hmr: string[] = [];
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (String(payload).includes('"type":"connected"')) {
              hmr.push(new URL(socket.url()).origin);
            }
          });
        });
        const response = await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
        expect(response?.headers()["content-security-policy"]).toContain("worker-src 'none'");
        await expect.poll(() => hmr.length).toBeGreaterThan(0);
        expect(hmr.every((url) => new URL(url).host === new URL(origin).host)).toBe(true);
        outcomes.hmr = hmr;

        outcomes.top = await page.evaluate(async (sinkOrigin) => {
          const results: Record<string, string> = {};
          const rejected = async (name: string, run: () => unknown) => {
            try {
              await run();
              results[name] = "allowed";
            } catch {
              results[name] = "blocked";
            }
          };
          await rejected("fetch", () => fetch(`${sinkOrigin}/fetch`));
          await rejected("rtc", () => new RTCPeerConnection());
          const workerUrl = URL.createObjectURL(
            new Blob(["postMessage('escaped')"], { type: "text/javascript" }),
          );
          const worker = new Worker(workerUrl);
          await rejected(
            "worker",
            () =>
              new Promise((resolve, reject) => {
                worker.addEventListener("message", resolve, { once: true });
                worker.addEventListener("error", reject, { once: true });
              }),
          );
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          results.popup = window.open(`${sinkOrigin}/popup`) === null ? "blocked" : "allowed";

          // Each native attempt completes at the browser's policy event; no sleep
          // or request interception can make a missing boundary pass this proof.
          const policy = async (name: string, directive: string, run: () => void) => {
            await new Promise<void>((resolve) => {
              const listener = (event: SecurityPolicyViolationEvent) => {
                if (
                  event.effectiveDirective !== directive ||
                  !event.blockedURI.startsWith(sinkOrigin)
                ) {
                  return;
                }
                document.removeEventListener("securitypolicyviolation", listener);
                resolve();
              };
              document.addEventListener("securitypolicyviolation", listener);
              run();
            });
            results[name] = "blocked";
          };
          await policy("xhr", "connect-src", () => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", `${sinkOrigin}/xhr`);
            xhr.send();
          });
          let events: EventSource;
          await policy("eventSource", "connect-src", () => {
            events = new EventSource(`${sinkOrigin}/events`);
          });
          events!.close();
          await policy("beacon", "connect-src", () => {
            navigator.sendBeacon(`${sinkOrigin}/beacon`, "probe");
          });
          await policy("image", "img-src", () => {
            const image = new Image();
            image.src = `${sinkOrigin}/image`;
            document.body.append(image);
          });
          await policy("media", "media-src", () => {
            const audio = document.createElement("audio");
            audio.preload = "auto";
            audio.src = `${sinkOrigin}/media`;
            document.body.append(audio);
            audio.load();
          });
          for (const setter of [
            "property",
            "attribute",
            "namespaced",
            "empty-namespace",
          ] as const) {
            await rejected(`iframe:${setter}`, () => {
              const frame = document.createElement("iframe");
              const url = `${sinkOrigin}/frame`;
              if (setter === "property") {
                frame.src = url;
              } else if (setter === "attribute") {
                frame.setAttribute("src", url);
              } else {
                const namespace = setter === "namespaced" ? null : "";
                frame.setAttributeNS(namespace, "src", url);
              }
              document.body.append(frame);
            });
          }
          await policy("script", "script-src-elem", () => {
            const script = document.createElement("script");
            script.src = `${sinkOrigin}/script`;
            document.head.append(script);
          });
          await policy("style", "style-src-elem", () => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = `${sinkOrigin}/style`;
            document.head.append(link);
          });
          await rejected("font", () =>
            new FontFace("sink-probe", `url(${sinkOrigin}/font)`).load(),
          );
          const forgedHmr = new WebSocket(
            `${sinkOrigin.replace("http:", "ws:")}/forged-hmr`,
            "vite-hmr",
          );
          await new Promise<void>((resolve) => {
            forgedHmr.addEventListener("error", () => resolve(), { once: true });
          });
          forgedHmr.close();
          results.forgedHmr = "blocked";
          const beforeNavigation = location.href;
          location.assign(`${sinkOrigin}/navigation`);
          results.navigation = location.href === beforeNavigation ? "blocked" : "allowed";
          // Same-origin completion sentinel proves the document is still live.
          const sentinel = await fetch("/control-ui-config.json");
          results.sentinel = sentinel.ok ? "local" : "failed";
          return results;
        }, sinkUrl);
        expect(outcomes.top).toEqual({
          fetch: "blocked",
          rtc: "blocked",
          worker: "blocked",
          popup: "blocked",
          xhr: "blocked",
          eventSource: "blocked",
          beacon: "blocked",
          image: "blocked",
          media: "blocked",
          "iframe:property": "blocked",
          "iframe:attribute": "blocked",
          "iframe:namespaced": "blocked",
          "iframe:empty-namespace": "blocked",
          script: "blocked",
          style: "blocked",
          font: "blocked",
          forgedHmr: "blocked",
          navigation: "blocked",
          sentinel: "local",
        });
        expect(new URL(page.url()).origin).toBe(origin);

        await expect
          .poll(() => page.frames().some((frame) => frame.url().startsWith("data:text/html")))
          .toBe(true);
        const widgetFrame = page
          .frames()
          .find((frame) => frame.url().startsWith("data:text/html"))!;
        outcomes.frame = await widgetFrame.evaluate(async (sinkOrigin) => {
          try {
            await fetch(`${sinkOrigin}/frame-native-fetch`);
            return "allowed";
          } catch {
            return "blocked";
          }
        }, sinkUrl);
        expect(outcomes.frame).toBe("blocked");
        const missing = await page.evaluate(async () => {
          const apiResponse = await fetch("/api/unimplemented-mock-probe");
          return { status: apiResponse.status, body: await apiResponse.json() };
        });
        expect(missing).toEqual({
          status: 404,
          body: { error: "Standalone mock has no HTTP fixture for this route." },
        });
        outcomes.missing = missing;
        await page.screenshot({ path: path.join(artifacts, "board.png") });
        expect(escaped).toEqual([]);
        expect(received).toEqual([]);
        expect(connections).toBe(0);
      },
      () => context?.close(),
      async () => {
        sink.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          sink.close((error) => (error ? reject(error) : resolve()));
        });
      },
      () =>
        writeFile(
          path.join(artifacts, "probes.json"),
          JSON.stringify(
            { origin, sinkOrigin: sinkUrl, connections, received, escaped, outcomes },
            null,
            2,
          ),
        ),
    );
  });

  it("serves attachment fixtures and blob previews under the same isolation policy", async () => {
    const attachments = await startFixtureServer("attachments");
    let context: BrowserContext | undefined;
    await runQaGatewayFixture(
      async () => {
        const artifacts = createControlUiE2eArtifactDir("standalone-isolated-attachments");
        context = await browser.newContext({ serviceWorkers: "block" });
        const origin = new URL(attachments.url).origin;
        const escaped: string[] = [];
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin === origin) {
            return route.continue();
          }
          escaped.push(route.request().url());
          return route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        await page.goto(`${origin}/chat`, { waitUntil: "networkidle" });
        const result = await page.evaluate(async () => {
          const response = await fetch("/__fixtures/chat-attachments/sample-image.svg");
          const blob = await response.blob();
          const image = new Image();
          image.src = URL.createObjectURL(blob);
          document.body.append(image);
          await image.decode();
          URL.revokeObjectURL(image.src);
          return {
            type: blob.type,
            width: image.naturalWidth,
            policy: response.headers.get("content-security-policy"),
          };
        });
        expect(result.type).toBe("image/svg+xml");
        expect(result.width).toBe(640);
        expect(result.policy).toContain("worker-src 'none'");
        await page.screenshot({ path: path.join(artifacts, "attachments.png") });
        expect(escaped).toEqual([]);
        await writeFile(
          path.join(artifacts, "network.json"),
          JSON.stringify({ origin, escaped, result }, null, 2),
        );
      },
      () => context?.close(),
      () => stopFixtureServer(attachments),
    );
  });

  for (const mode of ["dark", "light"] as const) {
    it(`themes dropdown items and widget frames in ${mode} mode`, async () => {
      const context = await browser.newContext({ colorScheme: mode });
      try {
        const page = await context.newPage();
        await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
        await expect
          .poll(() =>
            page.locator("html").evaluate((root) => ({
              classes: [...root.classList],
              theme: (root as HTMLElement).dataset.theme,
              themeMode: (root as HTMLElement).dataset.themeMode,
            })),
          )
          .toEqual({ classes: [`wa-${mode}`], theme: mode, themeMode: mode });

        await openWidgetMenu(page);
        const colors = await readMenuColors(page);
        expect(colorContrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);

        const widgetBackgrounds = await page
          .locator('[data-test-id="board-widget"]')
          .first()
          .evaluate((widget) => {
            const frame = widget.querySelector(".board-widget__frame");
            if (!(frame instanceof HTMLIFrameElement)) {
              throw new Error("board widget frame is missing");
            }
            return {
              frame: getComputedStyle(frame).backgroundColor,
              widget: getComputedStyle(widget).backgroundColor,
            };
          });
        expect(widgetBackgrounds.frame).toBe(widgetBackgrounds.widget);
        expect(widgetBackgrounds.frame).not.toBe("rgba(0, 0, 0, 0)");

        await expect
          .poll(() => page.frames().some((frame) => frame.url().startsWith("data:text/html")))
          .toBe(true);
        const widgetFrame = page.frames().find((frame) => frame.url().startsWith("data:text/html"));
        expect(widgetFrame).toBeDefined();
        await expect
          .poll(() =>
            widgetFrame!.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
          )
          .toBe(mode);
      } finally {
        await context.close();
      }
    });
  }

  it("renders the remove action with the menu font size and a leading trash icon", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
      await openWidgetMenu(page);
      const presentation = await page
        .locator(".board-widget__menu[open] .board-widget__menu-danger")
        .evaluate((remove) => {
          const preset = remove.parentElement?.querySelector(".board-widget__preset");
          const icon = remove.querySelector('[slot="icon"]');
          if (!(preset instanceof HTMLElement)) {
            throw new Error("board fixture menu did not expose a resize preset");
          }
          return {
            fontSize: getComputedStyle(remove).fontSize,
            iconHidden: icon?.getAttribute("aria-hidden"),
            iconSvg: Boolean(icon?.querySelector("svg")),
            presetFontSize: getComputedStyle(preset).fontSize,
          };
        });
      expect({
        fontSizesMatch: presentation.fontSize === presentation.presetFontSize,
        iconHidden: presentation.iconHidden,
        iconSvg: presentation.iconSvg,
      }).toEqual({
        fontSizesMatch: true,
        iconHidden: "true",
        iconSvg: true,
      });
    } finally {
      await page.close();
    }
  });

  it("follows live system color-scheme changes", async () => {
    const context = await browser.newContext({ colorScheme: "dark" });
    try {
      const page = await context.newPage();
      await page.goto(fixtureServer.url, { waitUntil: "networkidle" });
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await expect.poll(() => page.locator("html").getAttribute("class")).toBe("wa-light");
    } finally {
      await context.close();
    }
  });

  it("opens a visible catalog session with its transcript in chronological order", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("Release checklist sweep", { exact: true }).click();

      const transcript = [
        "Please sweep the release checklist for anything we missed.",
        "The release checklist is complete and ready for review.",
      ];
      await Promise.all(transcript.map((text) => page.getByText(text, { exact: true }).waitFor()));

      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--active .chat-thread .chat-bubble")
            .allTextContents()
            .then((messages) => messages.map((message) => message.trim())),
        )
        .toEqual(transcript);
      expect(
        await page
          .getByText("Cannot read properties of undefined (reading 'toReversed')", { exact: false })
          .count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("starts with aligned build identity and an upgraded chat pane", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("OpenClaw work checkout", { exact: true }).click();

      await page.getByRole("button", { name: "Write a message to send." }).waitFor();
      expect(await page.getByText("Server updated", { exact: true }).count()).toBe(0);
      const paneState = await page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
        .evaluate(async (pane) => {
          const chatPane = pane as HTMLElement & {
            hasUpdated?: boolean;
            updateComplete?: Promise<boolean>;
          };
          await chatPane.updateComplete;
          const constructor = customElements.get("openclaw-chat-pane");
          return {
            connected: chatPane.isConnected,
            hasUpdated: chatPane.hasUpdated,
            registered: constructor !== undefined,
            upgraded: constructor !== undefined && chatPane instanceof constructor,
          };
        });
      expect(paneState).toEqual({
        connected: true,
        hasUpdated: true,
        registered: true,
        upgraded: true,
      });
      expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("renders a deterministic reply after generic chat.send", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/chat", fixtureServer.url).toString(), { waitUntil: "networkidle" });
      await page.getByText("OpenClaw work checkout", { exact: true }).click();
      await page.getByRole("button", { name: "Write a message to send." }).waitFor();

      const prompt = "generic mock send probe";
      const composer = page.locator(
        ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
      );
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page
        .locator(".chat-thread-inner")
        .getByText(`Mock reply: ${prompt}`, { exact: true })
        .waitFor();
      expect(await composer.inputValue()).toBe("");
    } finally {
      await page.close();
    }
  });
});
