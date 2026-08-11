import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  fetchBrowserJson: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({ browser: {} })),
}));

vi.mock("./browser-tool.runtime.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
  fetchBrowserJson: mocks.fetchBrowserJson,
  getBrowserProfileCapabilities: () => ({ usesChromeMcp: false }),
  getRuntimeConfig: mocks.getRuntimeConfig,
  jsonResult: (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: value,
  }),
  normalizeOptionalString: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  readPositiveIntegerParam: (params: Record<string, unknown>, key: string) =>
    typeof params[key] === "number" ? params[key] : undefined,
  readStringParam: (
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; trim?: boolean },
  ) => {
    const value = params[key];
    if (typeof value === "string" && (value.length > 0 || options?.trim === false)) {
      return options?.trim === false ? value : value.trim();
    }
    if (options?.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  },
  resolveBrowserConfig: () => ({ profiles: {} }),
  resolveProfile: () => undefined,
}));

import { createBrowserExecTool } from "./browser-exec-tool.js";

const success = { ok: true, value: [1, 2], logs: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGatewayTool.mockResolvedValue(success);
  mocks.fetchBrowserJson.mockResolvedValue(success);
});

describe("browser_exec tool", () => {
  it("uses nested worker, browser.request, and Gateway timeout budgets", async () => {
    const signal = new AbortController().signal;
    const result = await createBrowserExecTool().execute(
      "call-1",
      { code: "return []", timeoutMs: 999_999 },
      signal,
    );

    expect(result.details).toEqual(success);
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "browser.request",
      { timeoutMs: 310_000 },
      {
        method: "POST",
        path: "/exec",
        query: undefined,
        body: { code: "return []", timeoutMs: 300_000 },
        timeoutMs: 305_000,
      },
      { scopes: ["operator.admin"], signal },
    );
  });

  it("uses the authenticated sandbox bridge without a Gateway round-trip", async () => {
    const result = await createBrowserExecTool({
      sandboxBridgeUrl: "http://127.0.0.1:9999/",
      allowHostControl: false,
    }).execute("call-1", { code: "return 1", profile: "worker", targetId: "tab-1" });

    expect(result.details).toEqual(success);
    expect(mocks.fetchBrowserJson).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/exec?profile=worker",
      expect.objectContaining({
        method: "POST",
        timeoutMs: 65_000,
        body: JSON.stringify({
          code: "return 1",
          profile: "worker",
          targetId: "tab-1",
          timeoutMs: 60_000,
        }),
      }),
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("pins trusted tab bindings into the route request", async () => {
    await createBrowserExecTool({
      runToolBinding: {
        kind: "tab",
        tabId: 3,
        target: "node",
        node: "browser-node",
        profile: "chrome",
        targetId: "target-3",
      },
    }).execute("call-1", { code: "return 1" });

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "browser.request",
      expect.any(Object),
      expect.objectContaining({
        target: "node",
        node: "browser-node",
        query: { profile: "chrome" },
        body: {
          code: "return 1",
          profile: "chrome",
          targetId: "target-3",
          pinnedTargetId: "target-3",
          timeoutMs: 60_000,
        },
      }),
      expect.any(Object),
    );
  });

  it("returns routing failures with a recovery next step", async () => {
    const result = await createBrowserExecTool({
      runToolBinding: {
        kind: "tab",
        tabId: 3,
        target: "host",
        profile: "chrome",
        targetId: "target-3",
      },
    }).execute("call-1", { code: "return 1", target: "node" });

    expect(result.details).toMatchObject({
      ok: false,
      logs: [],
      error: {
        name: "Error",
        message: expect.stringContaining("Retry browser_exec"),
      },
    });
  });
});
