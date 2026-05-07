import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { registerDiffsPlugin } from "./plugin.js";
import { createTempDiffRoot } from "./test-helpers.js";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
}));

let PlaywrightDiffScreenshotter: typeof import("./browser.js").PlaywrightDiffScreenshotter;
let resetSharedBrowserStateForTests: typeof import("./browser.js").resetSharedBrowserStateForTests;

vi.mock("playwright-core", () => ({
  chromium: {
    launch: launchMock,
  },
}));

afterAll(() => {
  vi.doUnmock("playwright-core");
  vi.resetModules();
});

describe("PlaywrightDiffScreenshotter", () => {
  let rootDir: string;
  let outputPath: string;
  let cleanupRootDir: () => Promise<void>;

  beforeAll(async () => {
    ({ PlaywrightDiffScreenshotter, resetSharedBrowserStateForTests } =
      await import("./browser.js"));
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ rootDir, cleanup: cleanupRootDir } = await createTempDiffRoot("openclaw-diffs-browser-"));
    outputPath = path.join(rootDir, "preview.png");
    launchMock.mockReset();
    await resetSharedBrowserStateForTests();
  });

  afterEach(async () => {
    await resetSharedBrowserStateForTests();
    vi.useRealTimers();
    await cleanupRootDir();
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
    expect(browser.newPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deviceScaleFactor: 2,
      }),
    );
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
    expect(pages[0]?.pdf).toHaveBeenCalledTimes(1);
    const pdfCall = pages[0]?.pdf.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(pdfCall).toBeDefined();
    expect(pdfCall).not.toHaveProperty("pageRanges");
    expect(pages[0]?.screenshot).toHaveBeenCalledTimes(0);
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
});

describe("diffs plugin registration", () => {
  it("uses live runtime tool config through the registered tool factory", async () => {
    type RegisteredTool = {
      execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    type HttpRouteHandler = (
      req: IncomingMessage,
      res: ServerResponse,
    ) => boolean | Promise<boolean>;
    type RegisteredHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

    let registeredToolFactory:
      | ((ctx: OpenClawPluginToolContext) => RegisteredTool | RegisteredTool[] | null | undefined)
      | undefined;
    let registeredHttpRouteHandler: HttpRouteHandler | undefined;
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
    } as OpenClawConfig;

    const api = createTestPluginApi({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {
        gateway: {
          port: 18789,
          bind: "loopback",
        },
      },
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
      runtime: {
        config: {
          current: () => configFile,
        },
      } as never,
      registerTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]) {
        registeredToolFactory = typeof tool === "function" ? tool : () => tool;
      },
      registerHttpRoute(params: RegisteredHttpRouteParams) {
        registeredHttpRouteHandler = params.handler as HttpRouteHandler;
      },
      on: vi.fn(),
    });

    registerDiffsPlugin(api as unknown as OpenClawPluginApi);

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
    } as OpenClawConfig;

    const registeredTool = registeredToolFactory?.({
      agentId: "main",
      sessionId: "session-456",
      messageChannel: "discord",
      agentAccountId: "default",
    }) as RegisteredTool | undefined;
    const result = await registeredTool?.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
    });
    const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
    const viewerPath = String(details?.viewerPath);
    const res = createMockServerResponse();
    const handled = await registeredHttpRouteHandler?.(
      localReq({
        method: "GET",
        url: viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(String(details?.viewerUrl)).toContain("https://live.example.com/gateway");
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('body data-theme="dark"');
    expect(String(res.body)).toContain('"backgroundEnabled":true');
    expect(String(res.body)).toContain('"diffStyle":"unified"');
    expect(String(res.body)).toContain('"disableLineNumbers":false');
    expect(String(res.body)).toContain('"diffIndicators":"bars"');
    expect(String(res.body)).toContain("--diffs-line-height: 24px;");
  });

  it("uses live runtime viewer-access config through the registered HTTP handler", async () => {
    type RegisteredTool = {
      execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    type HttpRouteHandler = (
      req: IncomingMessage,
      res: ServerResponse,
    ) => boolean | Promise<boolean>;
    type RegisteredHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

    let registeredToolFactory:
      | ((ctx: OpenClawPluginToolContext) => RegisteredTool | RegisteredTool[] | null | undefined)
      | undefined;
    let registeredHttpRouteHandler: HttpRouteHandler | undefined;
    const on = vi.fn();
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
    } as OpenClawConfig;

    const api = createTestPluginApi({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {
        gateway: {
          port: 18789,
          bind: "loopback",
        },
      },
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
      runtime: {
        config: {
          current: () => configFile,
        },
      } as never,
      registerTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]) {
        registeredToolFactory = typeof tool === "function" ? tool : () => tool;
      },
      registerHttpRoute(params: RegisteredHttpRouteParams) {
        registeredHttpRouteHandler = params.handler as HttpRouteHandler;
      },
      on,
    });

    registerDiffsPlugin(api as unknown as OpenClawPluginApi);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");
    const beforePromptBuild = on.mock.calls[0]?.[1];
    const promptResult = await beforePromptBuild?.({}, {});
    expect(promptResult).toMatchObject({
      prependSystemContext: expect.stringContaining("prefer the `diffs` tool"),
    });
    expect(promptResult?.prependContext).toBeUndefined();

    const registeredTool = registeredToolFactory?.({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    }) as RegisteredTool | undefined;
    const result = await registeredTool?.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
    });
    const viewerPath = String(
      (result as { details?: Record<string, unknown> } | undefined)?.details?.viewerPath,
    );
    const res = createMockServerResponse();
    const handled = await registeredHttpRouteHandler?.(
      localReq({
        method: "GET",
        url: viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect((result as { details?: Record<string, unknown> } | undefined)?.details?.context).toEqual(
      {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    );

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
    } as OpenClawConfig;

    const proxiedRes = createMockServerResponse();
    const proxiedHandled = await registeredHttpRouteHandler?.(
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
    type RegisteredTool = {
      execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    type HttpRouteHandler = (
      req: IncomingMessage,
      res: ServerResponse,
    ) => boolean | Promise<boolean>;
    type RegisteredHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

    let registeredToolFactory:
      | ((ctx: OpenClawPluginToolContext) => RegisteredTool | RegisteredTool[] | null | undefined)
      | undefined;
    let registeredHttpRouteHandler: HttpRouteHandler | undefined;
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
    } as OpenClawConfig;

    const api = createTestPluginApi({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {
        gateway: {
          port: 18789,
          bind: "loopback",
        },
      },
      pluginConfig: {
        security: {
          allowRemoteViewer: true,
        },
      },
      runtime: {
        config: {
          current: () => configFile,
        },
      } as never,
      registerTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]) {
        registeredToolFactory = typeof tool === "function" ? tool : () => tool;
      },
      registerHttpRoute(params: RegisteredHttpRouteParams) {
        registeredHttpRouteHandler = params.handler as HttpRouteHandler;
      },
      on: vi.fn(),
    });

    registerDiffsPlugin(api as unknown as OpenClawPluginApi);

    const registeredTool = registeredToolFactory?.({
      agentId: "main",
      sessionId: "session-789",
      messageChannel: "discord",
      agentAccountId: "default",
    }) as RegisteredTool | undefined;
    const result = await registeredTool?.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
    });
    const viewerPath = String(
      (result as { details?: Record<string, unknown> } | undefined)?.details?.viewerPath,
    );

    configFile = {
      ...configFile,
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;

    const proxiedRes = createMockServerResponse();
    const proxiedHandled = await registeredHttpRouteHandler?.(
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
    newPage: vi.fn(async () => {
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
