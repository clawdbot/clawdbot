import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { encodePngRgba } from "../../../src/media/png-encode.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionPath } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const selectedKey = "agent:main:loading-proof-12345678-0000-4000-8000-000000000001";
const homeKey = "agent:main:main";
const transcriptLength = 900;
// A synthetic 1×1 red AVIF; embedding bytes keeps live proof independent of host encoders.
const avifAvatar =
  "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACghYAAa0BDQbhDIaGUeHhiGJpppmgAAAkD+bDGFLK02PUUVOpCA=";
const viewport = { width: 1440, height: 900 };
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;
let config: OpenClawConfig;
let originalAvatarBytes = 0;

type RpcMetric = {
  method: string;
  sentMs: number;
  receivedMs?: number;
  responseBytes?: number;
  sessionKey?: string;
  shortId?: string;
  limit?: number;
  maxBytes?: number;
  offset?: number;
  messages?: number;
  historyBytes?: number;
  resolvedKey?: string;
  inlineAvatar?: boolean;
};

type BrowserPerformanceSample = {
  lcpMs: number | null;
  cls: number;
  longTasks: { count: number; totalMs: number; maxMs: number };
};

declare global {
  interface Window {
    loadingPerformance: BrowserPerformanceSample;
  }
}

async function readPerformanceSample(page: Page) {
  return page.evaluate(() => {
    const observed = window.loadingPerformance;
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      ...observed,
      fcpMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      navigation: navigation
        ? {
            ttfbMs: navigation.responseStart - navigation.requestStart,
            responseEndMs: navigation.responseEnd,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadMs: navigation.loadEventEnd,
          }
        : null,
    };
  });
}

function syntheticAvatar(): Buffer {
  const width = 1254;
  const rgba = Buffer.alloc(width * width * 4);
  let noise = 1;
  for (let pixel = 0; pixel < width * width; pixel += 1) {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const shade = noise >>> 24;
    const diamond =
      Math.abs((pixel % width) - width / 2) + Math.abs(Math.floor(pixel / width) - width / 2) < 270;
    rgba[pixel * 4] = diamond ? 240 : 70 + (shade >> 2);
    rgba[pixel * 4 + 1] = diamond ? 240 : 80 + (shade >> 2);
    rgba[pixel * 4 + 2] = diamond ? 255 : 150 + (shade >> 2);
    rgba[pixel * 4 + 3] = 255;
  }
  return encodePngRgba(rgba, width, width);
}

const suite = createControlUiE2eSuite({
  name: "Control UI chat loading performance with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({ name: "chat-loading-performance" });
    instance = owner;
    try {
      const workspace = owner.state.path("workspace");
      await mkdir(workspace, { recursive: true });
      const avatar = syntheticAvatar();
      originalAvatarBytes = avatar.length;
      await writeFile(path.join(workspace, "avatar.png"), avatar);
      config = {
        agents: {
          defaults: { workspace },
          entries: {
            main: {
              default: true,
              workspace,
              identity: { name: "Synthetic loading assistant", avatar: "avatar.png" },
            },
          },
        },
        gateway: {
          port: owner.port,
          auth: { mode: "token", token: owner.gatewayToken },
          controlUi: { enabled: true },
        },
      };
      await owner.state.writeConfig(config);
      // Ephemeral CLI probes intentionally have no user profile. Seed the real
      // shared-secret owner before a browser could adopt this machine's account name.
      const profileOptions = { env: owner.env };
      const profile = ensureGatewayOwnerProfile("Synthetic Viewer", profileOptions);
      const viewerPixels = Buffer.alloc(64 * 64 * 4);
      for (let offset = 0; offset < viewerPixels.length; offset += 4) {
        viewerPixels.set([190, 130, 70, 255], offset);
      }
      const avatarSaved = setAvatar(
        profile.id,
        encodePngRgba(viewerPixels, 64, 64),
        "image/png",
        profileOptions,
      );
      if (!avatarSaved.ok) {
        throw new Error(`Synthetic viewer avatar failed: ${avatarSaved.error.code}`);
      }
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      const diagnosticPath = path.join(suite.artifactDir, "gateway-setup.log");
      const diagnostic =
        `${error instanceof Error ? error.message : String(error)}\n${owner.logs()}`
          .replaceAll(owner.gatewayToken, "[redacted fixture token]")
          .replaceAll(owner.hookToken, "[redacted fixture token]");
      const failure = new Error(
        `Gateway fixture setup failed; sanitized diagnostics: ${diagnosticPath}`,
      );
      await runQaGatewayFixture(
        async () => {
          await writeFile(diagnosticPath, diagnostic);
          throw failure;
        },
        () => owner.cleanup(),
      );
      throw failure;
    }
  },
});

suite.define(() => {
  it("loads the selected tail before restored Home and caches shared avatar bytes", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const cliJson = async (args: string[]): Promise<Record<string, unknown>> => {
      const result = await owner.cli(["--no-color", ...args]);
      if (result.code !== 0) {
        const diagnostic = result.stderr
          .replaceAll(owner.gatewayToken, "[redacted fixture token]")
          .replaceAll(owner.hookToken, "[redacted fixture token]");
        throw new Error(
          `${args.slice(0, 3).join(" ")} failed (exit ${String(result.code)}): ${diagnostic}`,
        );
      }
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const syntheticViewer = await cliJson([
      "gateway",
      "call",
      "users.list",
      "--params",
      "{}",
      "--json",
    ]);
    expect(
      Array.isArray(syntheticViewer.profiles) &&
        syntheticViewer.profiles.some(
          (profile) =>
            isRecord(profile) &&
            profile.id === "gateway-owner" &&
            profile.displayName === "Synthetic Viewer",
        ),
    ).toBe(true);
    const sessions = [
      { key: selectedKey, label: "Synthetic loading proof", count: transcriptLength },
      { key: homeKey, label: "Synthetic Home", count: transcriptLength },
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `agent:main:unopened-${index}`,
        label: `Unopened synthetic conversation ${index + 1}`,
        count: 150,
      })),
    ];
    for (const session of sessions) {
      const created = await cliJson([
        "gateway",
        "call",
        "sessions.create",
        "--params",
        JSON.stringify({ key: session.key, agentId: "main", label: session.label }),
        "--json",
      ]);
      expect(created.ok).toBe(true);
      await appendTranscriptMessages(
        {
          agentId: "main",
          sessionKey: session.key,
          sessionId: String(created.sessionId),
          env: owner.env,
        },
        {
          config,
          messages: Array.from({ length: session.count }, (_, index) => ({
            message: {
              role: index % 2 === 0 ? "user" : "assistant",
              content: [
                {
                  type: "text",
                  text: `${session.label} message ${index + 1}.\n\n${"Synthetic transcript content for loading and pagination. ".repeat(72)}`,
                },
              ],
              timestamp: 1_780_000_000_000 + index * 1000,
            },
          })),
        },
      );
    }
    const handoff = await cliJson(["dashboard", "--json"]);
    const url = new URL(controlUiSessionPath(selectedKey), suite.server.baseUrl);
    url.hash = new URL(String(handoff.browserUrl)).hash;
    const artifactDir = suite.artifactDir;
    const rpc: RpcMetric[] = [];
    let measuring = false;
    let startedAt = 0;
    await suite.withPage(
      {
        viewport,
        serviceWorkers: "block",
        locale: "en-US",
        ...(captureUiProof ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      },
      async ({ page, context }) => {
        await page.addInitScript(() => {
          const sample: BrowserPerformanceSample = {
            lcpMs: null,
            cls: 0,
            longTasks: { count: 0, totalMs: 0, maxMs: 0 },
          };
          window.loadingPerformance = sample;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              sample.lcpMs = entry.startTime;
            }
          }).observe({ type: "largest-contentful-paint", buffered: true });
          let shiftWindow = { startMs: 0, lastMs: 0, total: 0 };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
              if (shift.hadRecentInput) {
                continue;
              }
              if (
                shiftWindow.total === 0 ||
                entry.startTime - shiftWindow.lastMs > 1000 ||
                entry.startTime - shiftWindow.startMs > 5000
              ) {
                shiftWindow = { startMs: entry.startTime, lastMs: entry.startTime, total: 0 };
              }
              shiftWindow.lastMs = entry.startTime;
              shiftWindow.total += shift.value;
              sample.cls = Math.max(sample.cls, shiftWindow.total);
            }
          }).observe({ type: "layout-shift", buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              sample.longTasks.count += 1;
              sample.longTasks.totalMs += entry.duration;
              sample.longTasks.maxMs = Math.max(sample.longTasks.maxMs, entry.duration);
            }
          }).observe({ type: "longtask", buffered: true });
        });
        const pending = new Map<string, RpcMetric>();
        const waitForStartupCommit = async (
          sessionKey: string,
          pane: Locator,
          requestStart = 0,
        ) => {
          await expect
            .poll(() =>
              rpc
                .slice(requestStart)
                .some(
                  (metric) =>
                    metric.method === "chat.startup" &&
                    (metric.sessionKey === sessionKey || metric.resolvedKey === sessionKey) &&
                    metric.receivedMs !== undefined,
                ),
            )
            .toBe(true);
          await expect
            .poll(() =>
              pane.evaluate(
                (element) =>
                  (element as HTMLElement & { transcriptLoading: boolean }).transcriptLoading,
              ),
            )
            .toBe(false);
          await pane.evaluate(async (element) => {
            await (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
          });
          return Date.now() - startedAt;
        };
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            if (!measuring) {
              return;
            }
            const frame: unknown = JSON.parse(payload.toString());
            if (
              !isRecord(frame) ||
              typeof frame.id !== "string" ||
              typeof frame.method !== "string"
            ) {
              return;
            }
            if (
              ![
                "chat.startup",
                "chat.history",
                "sessions.resolve",
                "agents.list",
                "agent.identity.get",
              ].includes(frame.method)
            ) {
              return;
            }
            const params = isRecord(frame.params) ? frame.params : {};
            const metric: RpcMetric = {
              method: frame.method,
              sentMs: Date.now() - startedAt,
              ...(typeof params.sessionKey === "string" ? { sessionKey: params.sessionKey } : {}),
              ...(typeof params.shortId === "string" ? { shortId: params.shortId } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
              ...(typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : {}),
              ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            };
            rpc.push(metric);
            pending.set(frame.id, metric);
          });
          socket.on("framereceived", ({ payload }) => {
            if (!measuring) {
              return;
            }
            const frame: unknown = JSON.parse(payload.toString());
            if (!isRecord(frame) || typeof frame.id !== "string") {
              return;
            }
            const metric = pending.get(frame.id);
            if (!metric) {
              return;
            }
            pending.delete(frame.id);
            metric.receivedMs = Date.now() - startedAt;
            metric.responseBytes = Buffer.byteLength(payload);
            const body = isRecord(frame.payload) ? frame.payload : {};
            if (Array.isArray(body.messages)) {
              metric.messages = body.messages.length;
              metric.historyBytes = Buffer.byteLength(JSON.stringify(body.messages));
            }
            if (isRecord(body.resolution) && typeof body.resolution.key === "string") {
              metric.resolvedKey = body.resolution.key;
            }
            metric.inlineAvatar = JSON.stringify(body).includes("data:image/");
          });
        });
        await page.goto(url.toString());
        await waitForControlUiGatewayReady(page);
        const selectedPane = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
        );
        await expect
          .poll(() =>
            selectedPane.evaluate(
              (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
            ),
          )
          .toBe(selectedKey);
        await selectedPane
          .locator(".chat-thread", {
            hasText: "Synthetic loading proof message 900.",
          })
          .waitFor();
        await selectedPane.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.locator(".sidebar-footer-bar__home").click();
        await page
          .locator("openclaw-assistant-panel .chat-thread")
          .getByText("Synthetic Home message 900.", { exact: false })
          .waitFor();
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifactDir, "01-restored-home-fixture.png") });
        }

        startedAt = Date.now();
        measuring = true;
        await page.reload();
        await waitForControlUiGatewayReady(page);
        const selectedCommitted = waitForStartupCommit(selectedKey, selectedPane);
        const homeCommitted = waitForStartupCommit(
          homeKey,
          page.locator("openclaw-assistant-panel openclaw-chat-pane"),
        );
        await selectedPane
          .locator(".chat-thread", {
            hasText: "Synthetic loading proof message 900.",
          })
          .waitFor();
        const selectedVisibleMs = Date.now() - startedAt;
        await selectedPane.locator(".agent-chat__composer-combobox textarea").waitFor();
        const composerVisibleMs = Date.now() - startedAt;
        const entryScripts = await page
          .locator("script[src]")
          .evaluateAll((elements) =>
            elements.map((element) => new URL((element as HTMLScriptElement).src).pathname),
          );
        await page
          .locator("openclaw-assistant-panel .chat-thread")
          .getByText("Synthetic Home message 900.", { exact: false })
          .waitFor();
        const homeVisibleMs = Date.now() - startedAt;
        const [selectedAuthoritativeMs, homeAuthoritativeMs] = await Promise.all([
          selectedCommitted,
          homeCommitted,
        ]);
        const performanceAtReady = await readPerformanceSample(page);
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLImageElement>(".sidebar-agent-card__avatar img")].some(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        );
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifactDir, "02-selected-and-home-ready.png") });
        }
        const startupMetrics = structuredClone(rpc);
        const images = await page
          .locator(".sidebar-agent-card__avatar img")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const image = element as HTMLImageElement;
              return { width: image.naturalWidth, height: image.naturalHeight };
            }),
          );
        const resources = await page.evaluate(() =>
          performance.getEntriesByType("resource").map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            return {
              path: new URL(resource.name).pathname,
              duration: resource.duration,
              transferSize: resource.transferSize,
              decodedBodySize: resource.decodedBodySize,
            };
          }),
        );
        const avatarResource = resources
          .filter((resource) => resource.path === "/avatar/main")
          .toSorted((left, right) => right.decodedBodySize - left.decodedBodySize)[0];
        const avatarUrl = await page.evaluate(
          () =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => new URL(entry.name).pathname === "/avatar/main")
              .toSorted(
                (left, right) =>
                  (right as PerformanceResourceTiming).decodedBodySize -
                  (left as PerformanceResourceTiming).decodedBodySize,
              )[0]?.name,
        );
        if (!avatarUrl) {
          throw new Error("Browser never requested the configured avatar route");
        }
        const avatarAuth = { Authorization: `Bearer ${owner.gatewayToken}` };
        const firstAvatar = await context.request.get(avatarUrl, { headers: avatarAuth });
        const etag = firstAvatar.headers().etag;
        const revalidated = await context.request.get(avatarUrl, {
          headers: { ...avatarAuth, "If-None-Match": etag ?? "" },
        });
        const cache = {
          status: firstAvatar.status(),
          bytes: (await firstAvatar.body()).length,
          control: firstAvatar.headers()["cache-control"],
          revalidatedStatus: revalidated.status(),
        };

        const thread = selectedPane.locator(".chat-thread");
        await thread.hover();
        await thread.evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.mouse.wheel(0, -500);
        await expect
          .poll(() =>
            rpc.some(
              (metric) =>
                metric.method === "chat.history" &&
                metric.sessionKey === selectedKey &&
                (metric.offset ?? 0) > 0 &&
                metric.receivedMs !== undefined,
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            selectedPane.evaluate(
              (element) =>
                (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                  .length,
            ),
          )
          .toBe(transcriptLength);
        // The prepend preserves the reader's anchor; a second gesture reaches the new start.
        await page.mouse.wheel(0, -1_000_000);
        await selectedPane
          .locator(".chat-thread", {
            hasText: "Synthetic loading proof message 1.",
          })
          .waitFor();
        if (captureUiProof) {
          await page.screenshot({ path: path.join(artifactDir, "03-older-history-loaded.png") });
        }
        const paginationMetrics = structuredClone(rpc.slice(startupMetrics.length));
        const captureNarrowReload = async (stage: string, homeOpen: boolean) => {
          await page.setViewportSize({ width: 1050, height: 900 });
          const requestStart = rpc.length;
          pending.clear();
          startedAt = Date.now();
          await page.reload();
          await waitForControlUiGatewayReady(page);
          const narrowSelectedCommitted = waitForStartupCommit(
            selectedKey,
            selectedPane,
            requestStart,
          );
          const narrowHomeCommitted = homeOpen
            ? waitForStartupCommit(
                homeKey,
                page.locator("openclaw-assistant-panel openclaw-chat-pane"),
                requestStart,
              )
            : Promise.resolve(null);
          await selectedPane
            .locator(".chat-thread", {
              hasText: "Synthetic loading proof message 900.",
            })
            .waitFor();
          const selectedMs = Date.now() - startedAt;
          await selectedPane.locator(".agent-chat__composer-combobox textarea").waitFor();
          const composerMs = Date.now() - startedAt;
          if (homeOpen) {
            await page
              .locator("openclaw-assistant-panel .chat-thread")
              .getByText("Synthetic Home message 900.", { exact: false })
              .waitFor();
          }
          const homeMs = homeOpen ? Date.now() - startedAt : null;
          const [narrowSelectedAuthoritativeMs, narrowHomeAuthoritativeMs] = await Promise.all([
            narrowSelectedCommitted,
            narrowHomeCommitted,
          ]);
          const performance = await readPerformanceSample(page);
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
          }
          return {
            width: 1050,
            homeOpen,
            selectedVisibleMs: selectedMs,
            composerVisibleMs: composerMs,
            homeVisibleMs: homeMs,
            selectedAuthoritativeMs: narrowSelectedAuthoritativeMs,
            homeAuthoritativeMs: narrowHomeAuthoritativeMs,
            performance,
            startup: structuredClone(rpc.slice(requestStart)),
          };
        };
        const narrowHomeOpen = await captureNarrowReload("04-narrow-home-restored", true);
        await page
          .locator("openclaw-assistant-panel")
          .getByRole("button", { name: "Close assistant sidebar", exact: true })
          .click();
        const narrowHomeClosed = await captureNarrowReload("05-narrow-home-closed", false);
        measuring = false;
        await writeFile(
          path.join(artifactDir, "loading-evidence.json"),
          JSON.stringify(
            {
              fixture: { synthetic: true, originalAvatarBytes, transcriptLength },
              entryScripts,
              selectedVisibleMs,
              composerVisibleMs,
              homeVisibleMs,
              selectedAuthoritativeMs,
              homeAuthoritativeMs,
              performanceAtReady,
              startup: startupMetrics,
              pagination: paginationMetrics,
              narrowHomeOpen,
              narrowHomeClosed,
              images,
              avatarResource,
              cache,
              resources,
            },
            null,
            2,
          ),
        );

        // Save measurements before asserting budgets so failures retain their evidence.
        const selectedStartup = startupMetrics.find(
          (metric) => metric.method === "chat.startup" && metric.resolvedKey === selectedKey,
        );
        expect(selectedStartup).toBeDefined();
        expect(
          startupMetrics.filter((metric) => metric.method === "sessions.resolve"),
        ).toHaveLength(0);
        expect(selectedStartup?.messages).toBeLessThanOrEqual(80);
        expect(selectedStartup?.historyBytes).toBeLessThanOrEqual(256 * 1024);
        const homeStartup = startupMetrics.find(
          (metric) => metric.method === "chat.startup" && metric.sessionKey === homeKey,
        );
        expect(homeStartup?.sentMs).toBeGreaterThanOrEqual(selectedStartup?.receivedMs ?? Infinity);
        for (const metrics of [startupMetrics, narrowHomeOpen.startup]) {
          expect(
            metrics.filter(
              (metric) => metric.method === "chat.history" && metric.sessionKey === homeKey,
            ),
          ).toHaveLength(0);
          expect(metrics.filter((metric) => metric.method === "agent.identity.get")).toHaveLength(
            1,
          );
        }
        expect(
          startupMetrics
            .filter((metric) => ["agents.list", "agent.identity.get"].includes(metric.method))
            .every((metric) => metric.inlineAvatar === false),
        ).toBe(true);
        expect(images.some((image) => image.width === 128 && image.height === 128)).toBe(true);
        expect(avatarResource).toBeDefined();
        expect(resources.filter((resource) => resource.path === "/avatar/main")).toHaveLength(1);
        expect(cache.status).toBe(200);
        expect(cache.bytes).toBeLessThan(originalAvatarBytes / 10);
        expect(cache.control).toContain("immutable");
        expect(cache.revalidatedStatus).toBe(304);

        // Change identity only after the loading sample is frozen; exercise each
        // format through the same authenticated HTTP loader used by the sidebar.
        const percentPng = encodePngRgba(
          Buffer.from([0, 128, 0, 255, 0, 128, 0, 255, 0, 128, 0, 255, 0, 128, 0, 255]),
          2,
          2,
        );
        const avatarFormats = [];
        let previousAvatarUrl = avatarUrl;
        await page.setViewportSize(viewport);
        for (const fixture of [
          { stage: "06-avif-avatar", dataUrl: avifAvatar, mime: "image/avif", width: 1, height: 1 },
          {
            stage: "07-percent-png-avatar",
            dataUrl: `data:image/png,${[...percentPng].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")}`,
            mime: "image/png",
            width: 2,
            height: 2,
          },
        ]) {
          const updated = await cliJson([
            "gateway",
            "call",
            "agents.update",
            "--params",
            JSON.stringify({ agentId: "main", avatar: fixture.dataUrl }),
            "--json",
          ]);
          expect(updated.ok).toBe(true);
          let versionedAvatarUrl = "";
          await expect
            .poll(async () => {
              const response = await context.request.get(
                `${suite.server.baseUrl}avatar/main?meta=1`,
                {
                  headers: avatarAuth,
                },
              );
              expect(response.status()).toBe(200);
              const metadata: unknown = await response.json();
              if (!isRecord(metadata)) {
                throw new Error("Avatar metadata was not an object");
              }
              versionedAvatarUrl = typeof metadata.avatarUrl === "string" ? metadata.avatarUrl : "";
              return {
                status: metadata.avatarStatus,
                changed:
                  new URL(versionedAvatarUrl, suite.server.baseUrl).href !== previousAvatarUrl,
              };
            })
            .toEqual({ status: "data", changed: true });
          expect(versionedAvatarUrl).toMatch(/^\/avatar\/main\?v=/u);
          previousAvatarUrl = new URL(versionedAvatarUrl, suite.server.baseUrl).href;
          const responseReady = page.waitForResponse(
            (response) => response.url() === new URL(versionedAvatarUrl, suite.server.baseUrl).href,
          );
          await page.reload();
          await waitForControlUiGatewayReady(page);
          const response = await responseReady;
          expect(response.status()).toBe(200);
          expect(response.headers()["content-type"]).toBe(fixture.mime);
          const avatarImage = page.locator(".sidebar-agent-card__avatar img");
          await expect
            .poll(() =>
              avatarImage.evaluate((image: HTMLImageElement) => ({
                complete: image.complete,
                width: image.naturalWidth,
                height: image.naturalHeight,
                blob: image.src.startsWith("blob:"),
              })),
            )
            .toEqual({
              complete: true,
              width: fixture.width,
              height: fixture.height,
              blob: true,
            });
          const dimensions = await avatarImage.evaluate((image: HTMLImageElement) => ({
            width: image.naturalWidth,
            height: image.naturalHeight,
          }));
          avatarFormats.push({
            format: fixture.stage,
            contentType: response.headers()["content-type"],
            ...dimensions,
          });
          if (captureUiProof) {
            await page.screenshot({ path: path.join(artifactDir, `${fixture.stage}.png`) });
          }
          await writeFile(
            path.join(artifactDir, "avatar-format-evidence.json"),
            JSON.stringify(avatarFormats, null, 2),
          );
        }
      },
    );
  });
});
