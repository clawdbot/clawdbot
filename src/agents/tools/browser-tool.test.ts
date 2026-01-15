import { afterEach, describe, expect, it, vi } from "vitest";

const browserClientMocks = vi.hoisted(() => ({
  browserCloseTab: vi.fn(async () => ({})),
  browserFocusTab: vi.fn(async () => ({})),
  browserOpenTab: vi.fn(async () => ({})),
  browserProfiles: vi.fn(async () => []),
  browserSnapshot: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
  browserStart: vi.fn(async () => ({})),
  browserStatus: vi.fn(async () => ({
    ok: true,
    running: true,
    pid: 1,
    cdpPort: 18792,
    cdpUrl: "http://127.0.0.1:18792",
  })),
  browserStop: vi.fn(async () => ({})),
  browserTabs: vi.fn(async () => []),
}));
vi.mock("../../browser/client.js", () => browserClientMocks);

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    controlHost: "127.0.0.1",
    controlPort: 18791,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#FF0000",
    headless: true,
    noSandbox: false,
    attachOnly: false,
    defaultProfile: "clawd",
    profiles: {
      clawd: {
        cdpPort: 18792,
        color: "#FF0000",
      },
    },
  })),
}));
vi.mock("../../browser/config.js", () => browserConfigMocks);

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));

const toolCommonMocks = vi.hoisted(() => ({
  imageResultFromFile: vi.fn(),
}));
vi.mock("./common.js", async () => {
  const actual = await vi.importActual<typeof import("./common.js")>("./common.js");
  return {
    ...actual,
    imageResultFromFile: toolCommonMocks.imageResultFromFile,
  };
});

import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import { createBrowserTool } from "./browser-tool.js";

describe("browser tool snapshot maxChars", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies the default ai snapshot limit", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "snapshot", format: "ai" });

    expect(browserClientMocks.browserSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18791",
      expect.objectContaining({
        format: "ai",
        maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      }),
    );
  });

  it("respects an explicit maxChars override", async () => {
    const tool = createBrowserTool();
    const override = 2_000;
    await tool.execute?.(null, {
      action: "snapshot",
      format: "ai",
      maxChars: override,
    });

    expect(browserClientMocks.browserSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18791",
      expect.objectContaining({
        maxChars: override,
      }),
    );
  });

  it("skips the default when maxChars is explicitly zero", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, {
      action: "snapshot",
      format: "ai",
      maxChars: 0,
    });

    expect(browserClientMocks.browserSnapshot).toHaveBeenCalled();
    const [, opts] = browserClientMocks.browserSnapshot.mock.calls.at(-1) ?? [];
    expect(Object.hasOwn(opts ?? {}, "maxChars")).toBe(false);
  });

  it("lists profiles", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "profiles" });

    expect(browserClientMocks.browserProfiles).toHaveBeenCalledWith("http://127.0.0.1:18791");
  });

  it("passes refs mode through to browser snapshot", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "snapshot", format: "ai", refs: "aria" });

    expect(browserClientMocks.browserSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18791",
      expect.objectContaining({
        format: "ai",
        refs: "aria",
      }),
    );
  });

  it("defaults to host when using profile=chrome (even in sandboxed sessions)", async () => {
    const tool = createBrowserTool({ defaultControlUrl: "http://127.0.0.1:9999" });
    await tool.execute?.(null, { action: "snapshot", profile: "chrome", format: "ai" });

    expect(browserClientMocks.browserSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18791",
      expect.objectContaining({
        profile: "chrome",
      }),
    );
  });
});

describe("browser tool snapshot labels", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns image + text when labels are requested", async () => {
    const tool = createBrowserTool();
    const imageResult = {
      content: [
        { type: "text", text: "label text" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/snap.png" },
    };

    toolCommonMocks.imageResultFromFile.mockResolvedValueOnce(imageResult);
    browserClientMocks.browserSnapshot.mockResolvedValueOnce({
      ok: true,
      format: "ai",
      targetId: "t1",
      url: "https://example.com",
      snapshot: "label text",
      imagePath: "/tmp/snap.png",
    });

    const result = await tool.execute?.(null, {
      action: "snapshot",
      format: "ai",
      labels: true,
    });

    expect(toolCommonMocks.imageResultFromFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/tmp/snap.png",
        extraText: "label text",
      }),
    );
    expect(result).toEqual(imageResult);
    expect(result?.content).toHaveLength(2);
    expect(result?.content?.[0]).toMatchObject({ type: "text", text: "label text" });
    expect(result?.content?.[1]).toMatchObject({ type: "image" });
  });
});
