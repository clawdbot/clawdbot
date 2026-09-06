// Diffs tests cover browser plugin behavior.
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { registerDiffsPlugin } from "./plugin.js";
import { createTempDiffRoot } from "./test-helpers.js";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
}));

let PlaywrightDiffScreenshotter: typeof import("./browser.runtime.js").PlaywrightDiffScreenshotter;

vi.mock("playwright-core", () => ({
  chromium: {
    launch: launchMock,
  },
}));

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

afterAll(() => {
  vi.doUnmock("playwright-core");
  vi.resetModules();
});

describe("PlaywrightDiffScreenshotter", () => {
  let rootDir: string;
  let outputPath: string;
  let cleanupRootDir: () => Promise<void>;
  let originalPlatform: PropertyDescriptor;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor) {
      throw new Error("process.platform descriptor is unavailable");
    }
    originalPlatform = platformDescriptor;
    ({ PlaywrightDiffScreenshotter } = await import("./browser.runtime.js"));
    ({ rootDir, cleanup: cleanupRootDir } = await createTempDiffRoot("openclaw-diffs-browser-"));
    outputPath = path.join(rootDir, "preview.png");
    launchMock.mockReset();
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await cleanupRootDir();
  });

  async function renderWithBrowserDiscovery(): Promise<{ executablePath?: string }> {
    launchMock.mockResolvedValue(createMockBrowser([]));
    const screenshotter = new PlaywrightDiffScreenshotter({ config: {}, browserIdleMs: 1_000 });
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 1,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });
    return firstMockCall(launchMock, "browser launch")[0] as { executablePath?: string };
  }

  function stubWindowsBrowserDiscoveryEnv(params: {
    localAppData: string;
    programFiles: string;
    programFilesX86: string;
  }): void {
    Object.defineProperty(process, "platform", {
      ...originalPlatform,
      value: "win32",
    });
    vi.stubEnv("PATH", "");
    vi.stubEnv("OPENCLAW_BROWSER_EXECUTABLE_PATH", "");
    vi.stubEnv("BROWSER_EXECUTABLE_PATH", "");
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "");
    vi.stubEnv("LOCALAPPDATA", params.localAppData);
    vi.stubEnv("ProgramFiles", params.programFiles);
    vi.stubEnv("ProgramFiles(x86)", params.programFilesX86);
  }

  it("uses the Windows per-user install root when LOCALAPPDATA is blank", async () => {
    stubWindowsBrowserDiscoveryEnv({
      localAppData: " \t ",
      programFiles: "",
      programFilesX86: "   ",
    });
    vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\test");
    const chromePath = "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    const accessMock = vi.spyOn(fs, "access").mockImplementation(async (candidate) => {
      if (String(candidate) !== chromePath) {
        throw new Error("ENOENT");
      }
    });

    await expect(renderWithBrowserDiscovery()).resolves.toEqual(
      expect.objectContaining({ executablePath: chromePath }),
    );
    expect(accessMock.mock.calls.map(([candidate]) => String(candidate))).toEqual([chromePath]);
  });

  it("uses standard Windows system roots when install-root overrides are blank", async () => {
    stubWindowsBrowserDiscoveryEnv({
      localAppData: " ",
      programFiles: " \t ",
      programFilesX86: "",
    });
    vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\test");
    const accessMock = vi.spyOn(fs, "access").mockRejectedValue(new Error("ENOENT"));

    await expect(renderWithBrowserDiscovery()).resolves.not.toHaveProperty("executablePath");
    const candidates = accessMock.mock.calls.map(([candidate]) => String(candidate));
    expect(candidates).toEqual([
      "C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ]);
    expect(candidates.every((candidate) => path.win32.isAbsolute(candidate))).toBe(true);
  });

  it("preserves custom Windows install-root precedence", async () => {
    stubWindowsBrowserDiscoveryEnv({
      localAppData: "D:\\User Apps",
      programFiles: "D:\\System Apps",
      programFilesX86: "D:\\System Apps x86",
    });
    const customChromePath = "D:\\User Apps\\Google\\Chrome\\Application\\chrome.exe";
    const accessMock = vi.spyOn(fs, "access").mockImplementation(async (candidate) => {
      if (String(candidate) !== customChromePath) {
        throw new Error("ENOENT");
      }
    });

    await expect(renderWithBrowserDiscovery()).resolves.toEqual(
      expect.objectContaining({ executablePath: customChromePath }),
    );
    expect(accessMock.mock.calls.map(([candidate]) => String(candidate))).toEqual([
      customChromePath,
    ]);
  });

  it("reuses the same browser across renders and closes it after the idle window", async () => {
    const { pages, browser, screenshotter } = await createScreenshotterHarness();

    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });
    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "dark",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
    const firstPageParams = (
      browser.newPage.mock.calls as Array<[{ deviceScaleFactor?: number }?]>
    )[0]?.[0];
    expect(firstPageParams?.deviceScaleFactor).toBe(2);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.close).toHaveBeenCalledTimes(1);
    expect(pages[1]?.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath,
      theme: "light",
      image: {
        format: "png",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });

    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["config", "runtimeConfig"] as const)(
    "uses explicit tool %s for viewer links and screenshot browser selection",
    async (configField) => {
      const processConfig: OpenClawConfig = {
        gateway: { publicOrigin: "https://process.example" },
        browser: { executablePath: path.join(rootDir, "unavailable-browser") },
      };
      const explicitConfig: OpenClawConfig = {
        gateway: { publicOrigin: "https://explicit.example" },
        browser: { executablePath: process.execPath },
      };
      const { render } = createRegistrationHarness({
        pluginConfig: {},
        currentConfig: () => processConfig,
      });
      launchMock.mockResolvedValue(createMockBrowser([]));

      const { details } = await render({ config: processConfig, [configField]: explicitConfig });

      expect
        .soft(String(details.viewerUrl))
        .toContain("https://explicit.example/plugins/diffs/view/");
      expect(details.fileError).toBeUndefined();
      expect(launchMock).toHaveBeenCalledWith(
        expect.objectContaining({ executablePath: process.execPath }),
      );
      await expect(fs.readFile(String(details.filePath), "utf8")).resolves.toBe("png");
    },
  );

  it("renders PDF output when format is pdf", async () => {
    const { pages, screenshotter } = await createScreenshotterHarness();
    const pdfPath = path.join(rootDir, "preview.pdf");

    await screenshotter.screenshotHtml({
      html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
      outputPath: pdfPath,
      theme: "light",
      image: {
        format: "pdf",
        qualityPreset: "standard",
        scale: 2,
        maxWidth: 960,
        maxPixels: 8_000_000,
      },
    });

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    const page = expectDefined(pages[0], "diffs browser page");
    expect(page.pdf).toHaveBeenCalledTimes(1);
    const pdfCall = firstMockCall(page.pdf, "PDF render")[0] as Record<string, unknown> | undefined;
    if (!pdfCall) {
      throw new Error("expected PDF render call");
    }
    expect(pdfCall).not.toHaveProperty("pageRanges");
    expect(page.screenshot).toHaveBeenCalledTimes(0);
    await expect(fs.readFile(pdfPath, "utf8")).resolves.toContain("%PDF-1.7");
  });

  it("fails fast when PDF render exceeds size limits", async () => {
    const pages: Array<{
      close: ReturnType<typeof vi.fn>;
      screenshot: ReturnType<typeof vi.fn>;
      pdf: ReturnType<typeof vi.fn>;
    }> = [];
    const browser = createMockBrowser(pages, {
      boundingBox: { x: 40, y: 40, width: 960, height: 60_000 },
    });
    launchMock.mockResolvedValue(browser);
    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });
    const pdfPath = path.join(rootDir, "oversized.pdf");

    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath: pdfPath,
        theme: "light",
        image: {
          format: "pdf",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
          maxPixels: 8_000_000,
        },
      }),
    ).rejects.toThrow("Diff frame did not render within image size limits.");

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(0);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });

  it("fails fast when maxPixels is still exceeded at scale 1", async () => {
    const { pages, screenshotter } = await createScreenshotterHarness();

    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath,
        theme: "dark",
        image: {
          format: "png",
          qualityPreset: "standard",
          scale: 1,
          maxWidth: 960,
          maxPixels: 10,
        },
      }),
    ).rejects.toThrow("Diff frame did not render within image size limits.");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
  });

  it("wraps browser launch failures with Chromium installation guidance", async () => {
    launchMock.mockRejectedValue(new Error("launch failed"));
    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });

    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath,
        theme: "dark",
        image: {
          format: "png",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
          maxPixels: 8_000_000,
        },
      }),
    ).rejects.toThrow("requires a Chromium-compatible browser");
  });

  it("wraps new-page failures with Chromium installation guidance", async () => {
    const browser = createMockBrowser([]);
    browser.newPage.mockRejectedValue(new Error("page creation failed"));
    launchMock.mockResolvedValue(browser);
    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });

    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath,
        theme: "dark",
        image: {
          format: "png",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
          maxPixels: 8_000_000,
        },
      }),
    ).rejects.toThrow("requires a Chromium-compatible browser");
  });

  it("preserves render errors after a browser page has opened", async () => {
    const browser = createMockBrowser([]);
    const page = createMockPage();
    page.waitForFunction.mockRejectedValue(new Error("hydration timeout"));
    browser.newPage.mockResolvedValue(page);
    launchMock.mockResolvedValue(browser);
    const screenshotter = new PlaywrightDiffScreenshotter({
      config: createConfig(),
      browserIdleMs: 1_000,
    });

    await expect(
      screenshotter.screenshotHtml({
        html: '<html><head></head><body><main class="oc-frame"></main></body></html>',
        outputPath,
        theme: "dark",
        image: {
          format: "png",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
          maxPixels: 8_000_000,
        },
      }),
    ).rejects.toThrow("hydration timeout");
  });
});

function createRegistrationHarness(params: {
  pluginConfig: Record<string, unknown>;
  currentConfig: () => OpenClawConfig;
}) {
  const registered: {
    tool?: Parameters<OpenClawPluginApi["registerTool"]>[0];
    httpHandler?: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]["handler"];
  } = {};
  const on = vi.fn();
  const blobStore = createMemoryBlobStore();
  const api = createTestPluginApi({
    id: "diffs",
    name: "Diffs",
    description: "Diffs",
    source: "test",
    config: { gateway: { port: 18789, bind: "loopback" } },
    pluginConfig: params.pluginConfig,
    runtime: {
      config: { current: params.currentConfig },
      state: { openBlobStore: () => blobStore },
    } as never,
    registerTool(tool) {
      registered.tool = tool;
    },
    registerHttpRoute(route) {
      registered.httpHandler = route.handler;
    },
    on,
  });
  registerDiffsPlugin(api);
  const registration = expectDefined(registered.tool, "registered diffs tool");
  const handleRequest = expectDefined(registered.httpHandler, "registered diffs HTTP handler");

  return {
    on,
    handleRequest,
    render: async (context: OpenClawPluginToolContext) => {
      const tool = expectDefined(
        typeof registration === "function" ? registration(context) : registration,
        "diffs tool for context",
      );
      if (Array.isArray(tool)) {
        throw new Error("expected one registered diffs tool");
      }
      const result = await tool.execute("tool-1", { before: "one\n", after: "two\n" });
      const details = expectDefined(asOptionalRecord(result.details), "diffs tool details");
      const viewerPath = details.viewerPath;
      if (typeof viewerPath !== "string") {
        throw new Error("expected a diff viewer path");
      }
      return { details, viewerPath };
    },
  };
}

describe("diffs plugin registration", () => {
  it("uses live runtime tool config through the registered tool factory", async () => {
    let configFile: OpenClawConfig = {
      gateway: {
        port: 18789,
        bind: "loopback",
      },
      plugins: {
        entries: {
          diffs: {
            config: {
              viewerBaseUrl: "https://startup.example.com/openclaw",
              defaults: {
                mode: "view",
                theme: "light",
                background: false,
                layout: "split",
                showLineNumbers: false,
                diffIndicators: "classic",
                lineSpacing: 2,
              },
            },
          },
        },
      },
    };
    const { render, handleRequest } = createRegistrationHarness({
      pluginConfig: {
        viewerBaseUrl: "https://startup.example.com/openclaw",
        defaults: {
          mode: "view",
          theme: "light",
          background: false,
          layout: "split",
          showLineNumbers: false,
          diffIndicators: "classic",
          lineSpacing: 2,
        },
      },
      currentConfig: () => configFile,
    });

    configFile = {
      ...configFile,
      plugins: {
        entries: {
          diffs: {
            config: {
              viewerBaseUrl: "https://live.example.com/gateway",
              defaults: {
                mode: "view",
                theme: "dark",
                background: true,
                layout: "unified",
                showLineNumbers: true,
                diffIndicators: "bars",
                lineSpacing: 1.6,
              },
            },
          },
        },
      },
    };

    const { details, viewerPath } = await render({
      agentId: "main",
      sessionId: "session-456",
      messageChannel: "discord",
      agentAccountId: "default",
    });
    const res = createMockServerResponse();
    const handled = await handleRequest(
      localReq({
        method: "GET",
        url: viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(String(details.viewerUrl)).toContain("https://live.example.com/gateway");
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('body data-theme="dark"');
    expect(String(res.body)).toContain('"backgroundEnabled":true');
    expect(String(res.body)).toContain('"diffStyle":"unified"');
    expect(String(res.body)).toContain('"disableLineNumbers":false');
    expect(String(res.body)).toContain('"diffIndicators":"bars"');
    expect(String(res.body)).toContain("--diffs-line-height: 24px;");
  });

  it("uses live runtime viewer-access config through the registered HTTP handler", async () => {
    let configFile: OpenClawConfig = {
      gateway: {
        port: 18789,
        bind: "loopback",
      },
      plugins: {
        entries: {
          diffs: {
            config: {
              security: {
                allowRemoteViewer: true,
              },
            },
          },
        },
      },
    };
    const { on, render, handleRequest } = createRegistrationHarness({
      pluginConfig: {
        defaults: {
          mode: "view",
          theme: "light",
          background: false,
          layout: "split",
          showLineNumbers: false,
          diffIndicators: "classic",
          lineSpacing: 2,
        },
        security: {
          allowRemoteViewer: true,
        },
      },
      currentConfig: () => configFile,
    });

    expect(on).toHaveBeenCalledTimes(1);
    const [hookName, beforePromptBuild] = firstMockCall(on, "plugin hook registration");
    expect(hookName).toBe("before_prompt_build");
    if (typeof beforePromptBuild !== "function") {
      throw new Error("expected before_prompt_build callback");
    }
    const promptResult = await beforePromptBuild({}, {});
    expect(promptResult?.prependSystemContext).toBe(
      [
        "When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.",
        "It accepts either `before` + `after` text or a unified `patch`.",
        "Check `details.changed`: identical before/after input returns `false` without creating an artifact; rendered results return `true`.",
        "`mode=view` returns `details.viewerUrl` for interactive viewing; `mode=file` returns `details.filePath`; `mode=both` returns both.",
        "To send the rendered file, use an available file-sending tool to send `details.filePath` as an attachment.",
        "Include `path` when you know the filename, and omit presentation overrides unless needed.",
      ].join("\n"),
    );
    // This guidance is prepended unconditionally, so it must not name a tool owned by
    // another toolset: `message` is absent whenever `disableMessageTool` is set, and
    // `canvas` ships as a separate plugin.
    expect(promptResult?.prependSystemContext).not.toMatch(/\bmessage\b|\bcanvas\b/i);
    expect(promptResult?.prependContext).toBeUndefined();

    const { details, viewerPath } = await render({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });
    const res = createMockServerResponse();
    const handled = await handleRequest(
      localReq({
        method: "GET",
        url: viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(details.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });

    configFile = {
      ...configFile,
      plugins: {
        entries: {
          diffs: {
            config: {
              security: {
                allowRemoteViewer: false,
              },
            },
          },
        },
      },
    };

    const proxiedRes = createMockServerResponse();
    const proxiedHandled = await handleRequest(
      localReq({
        method: "GET",
        url: viewerPath,
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
      }),
      proxiedRes,
    );

    expect(proxiedHandled).toBe(true);
    expect(proxiedRes.statusCode).toBe(404);
  });

  it("fails closed for remote viewer access when the live diffs plugin entry is removed", async () => {
    let configFile: OpenClawConfig = {
      gateway: {
        port: 18789,
        bind: "loopback",
      },
      plugins: {
        entries: {
          diffs: {
            config: {
              security: {
                allowRemoteViewer: true,
              },
            },
          },
        },
      },
    };
    const { render, handleRequest } = createRegistrationHarness({
      pluginConfig: {
        security: {
          allowRemoteViewer: true,
        },
      },
      currentConfig: () => configFile,
    });

    const { viewerPath } = await render({
      agentId: "main",
      sessionId: "session-789",
      messageChannel: "discord",
      agentAccountId: "default",
    });

    configFile = {
      ...configFile,
      plugins: {
        entries: {},
      },
    };

    const proxiedRes = createMockServerResponse();
    const proxiedHandled = await handleRequest(
      localReq({
        method: "GET",
        url: viewerPath,
        headers: {
          "x-forwarded-for": "203.0.113.10",
        },
      }),
      proxiedRes,
    );

    expect(proxiedHandled).toBe(true);
    expect(proxiedRes.statusCode).toBe(404);
  });
});

function createMemoryBlobStore<TMetadata>(): PluginBlobStore<TMetadata> {
  const entries = new Map<
    string,
    {
      bytes: Uint8Array;
      metadata: TMetadata;
      createdAt: number;
      expiresAt?: number;
    }
  >();
  const read = (key: string): PluginBlobEntry<TMetadata> | undefined => {
    const entry = entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return {
      key,
      bytes: entry.bytes.slice(),
      metadata: entry.metadata,
      sizeBytes: entry.bytes.byteLength,
      createdAt: entry.createdAt,
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    };
  };
  const register: PluginBlobStore<TMetadata>["register"] = async (key, bytes, metadata, opts) => {
    const createdAt = Date.now();
    entries.set(key, {
      bytes: bytes.slice(),
      metadata,
      createdAt,
      ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
    });
  };
  return {
    register,
    async registerIfAbsent(key, bytes, metadata, opts) {
      if (read(key)) {
        return false;
      }
      await register(key, bytes, metadata, opts);
      return true;
    },
    async lookup(key) {
      return read(key);
    },
    async entries() {
      return [...entries.keys()].flatMap((key) => {
        const entry = read(key);
        if (!entry) {
          return [];
        }
        const { bytes: _bytes, ...info } = entry;
        return [info];
      });
    },
    async delete(key) {
      return entries.delete(key);
    },
    async deleteExpiredKey(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt === undefined || entry.expiresAt > Date.now()) {
        return undefined;
      }
      entries.delete(key);
      return {
        key,
        metadata: entry.metadata,
        sizeBytes: entry.bytes.byteLength,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      };
    },
    async deleteExpired() {
      const expired: PluginBlobEntryInfo<TMetadata>[] = [];
      for (const [key, entry] of entries) {
        if (entry.expiresAt === undefined || entry.expiresAt > Date.now()) {
          continue;
        }
        entries.delete(key);
        expired.push({
          key,
          metadata: entry.metadata,
          sizeBytes: entry.bytes.byteLength,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
      }
      return expired;
    },
    async clear() {
      entries.clear();
    },
  };
}

function createConfig(): OpenClawConfig {
  return {
    browser: {
      executablePath: process.execPath,
    },
  } as OpenClawConfig;
}

function localReq(input: {
  method: string;
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

async function createScreenshotterHarness(options?: {
  boundingBox?: { x: number; y: number; width: number; height: number };
}) {
  const pages: Array<{
    close: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    pdf: ReturnType<typeof vi.fn>;
  }> = [];
  const browser = createMockBrowser(pages, options);
  launchMock.mockResolvedValue(browser);
  const screenshotter = new PlaywrightDiffScreenshotter({
    config: createConfig(),
    browserIdleMs: 1_000,
  });
  return { pages, browser, screenshotter };
}

function createMockBrowser(
  pages: Array<{
    close: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    pdf: ReturnType<typeof vi.fn>;
  }>,
  options?: { boundingBox?: { x: number; y: number; width: number; height: number } },
) {
  const browser = {
    newPage: vi.fn(async (_options?: unknown) => {
      const page = createMockPage(options);
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
    on: vi.fn(),
  };
  return browser;
}

function createMockPage(options?: {
  boundingBox?: { x: number; y: number; width: number; height: number };
}) {
  const box = options?.boundingBox ?? { x: 40, y: 40, width: 640, height: 240 };
  const screenshot = vi.fn(async ({ path: screenshotPath }: { path: string }) => {
    await fs.writeFile(screenshotPath, Buffer.from("png"));
  });
  const pdf = vi.fn(async ({ path: pdfPath }: { path: string }) => {
    await fs.writeFile(pdfPath, "%PDF-1.7 mock");
  });

  return {
    route: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 1),
    emulateMedia: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => {}),
      boundingBox: vi.fn(async () => box),
    })),
    setViewportSize: vi.fn(async () => {}),
    screenshot,
    pdf,
    close: vi.fn(async () => {}),
  };
}
