import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { canvasHandlers } from "./canvas.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const readDocument = vi.hoisted(() => vi.fn());
vi.mock("../../canvas/documents.js", () => ({ readCanvasDocumentHtmlSource: readDocument }));

function createHarness() {
  const client = {
    connect: { role: "operator", scopes: ["operator.read"] },
    connId: "viewer",
  } as GatewayClient;
  const context = {
    getRuntimeConfig: () => ({}),
    getMcpAppSandboxPort: () => 18790,
    ensureSandboxHostPort: vi.fn(async () => 18790),
    isConnectionActive: () => true,
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  const invoke = async (
    params: Record<string, unknown> = { docId: "cv_widget" },
    options: Partial<GatewayRequestHandlerOptions> = {},
  ) => {
    const respond = vi.fn();
    await canvasHandlers["canvas.document.view"]!({
      req: { type: "req", id: "view", method: "canvas.document.view", params },
      params,
      client,
      context,
      isWebchatConnect: () => true,
      respond,
      ...options,
    });
    return respond;
  };
  return { client, context, invoke };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  readDocument.mockReset().mockResolvedValue({ html: "<p>Widget</p>", cspSandbox: "scripts" });
});
afterEach(() => resetGatewayWorkAdmission());

describe("canvas.document.view", () => {
  it("returns only the hosted document and isolated sandbox metadata", async () => {
    const { context, invoke } = createHarness();
    context.getRuntimeConfig = () => ({
      mcp: { apps: { sandboxOrigin: "https://sandbox.example" } },
    });
    const respond = await invoke();
    expect(respond.mock.calls[0]).toEqual([
      true,
      {
        html: "<p>Widget</p>",
        sandboxUrl: expect.stringMatching(/^\/mcp-app-sandbox\?csp=/),
        sandboxPort: 18790,
        sandboxOrigin: "https://sandbox.example",
      },
    ]);
    expect(context.ensureSandboxHostPort).not.toHaveBeenCalled();
  });

  it("starts sandbox provisioning while the document read is pending", async () => {
    const { context, invoke } = createHarness();
    const document = createDeferred<{ html: string; cspSandbox: "scripts" }>();
    const sandbox = createDeferred<number>();
    readDocument.mockReturnValue(document.promise);
    context.getMcpAppSandboxPort = () => undefined;
    vi.mocked(context.ensureSandboxHostPort!).mockReturnValue(sandbox.promise);
    const pending = invoke();
    expect(readDocument).toHaveBeenCalledWith("cv_widget", { maxBytes: 2 * 1024 * 1024 });
    expect(context.ensureSandboxHostPort).toHaveBeenCalledOnce();
    sandbox.resolve(18790);
    document.resolve({ html: "<p>Widget</p>", cspSandbox: "scripts" });
    expect((await pending).mock.calls[0]?.[0]).toBe(true);
  });

  it.each([{}, { docId: "../private" }, { docId: "." }, { docId: "cv_widget", html: "injected" }])(
    "rejects invalid document identifiers and extra source fields: %j",
    async (params) => {
      const { invoke } = createHarness();
      const respond = await invoke(params);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(readDocument).not.toHaveBeenCalled();
    },
  );

  it("honors Canvas hosting disablement before reading content", async () => {
    const { context, invoke } = createHarness();
    context.getRuntimeConfig = () => ({
      plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
    });
    const respond = await invoke();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("refuses non-widget documents and oversized widget bytes", async () => {
    const { invoke } = createHarness();
    for (const document of [
      { html: "<p>Non-widget artifact</p>" },
      { html: "x".repeat(2 * 1024 * 1024 + 1), cspSandbox: "scripts" },
    ]) {
      readDocument.mockResolvedValueOnce(document);
      expect((await invoke()).mock.calls[0]?.[0]).toBe(false);
    }
  });

  it.each(["gateway", "client", "signal", "configuration"] as const)(
    "rejects a retired %s before returning awaited content",
    async (boundary) => {
      const { context, client, invoke } = createHarness();
      const document = createDeferred<{ html: string; cspSandbox: "scripts" }>();
      readDocument.mockReturnValue(document.promise);
      const controller = new AbortController();
      const pending = invoke(undefined, { signal: controller.signal });
      if (boundary === "gateway") {
        context.resolveGatewayContext = () => undefined;
      }
      if (boundary === "client") {
        client.invalidated = true;
      }
      if (boundary === "signal") {
        controller.abort();
      }
      if (boundary === "configuration") {
        context.getRuntimeConfig = () => ({
          plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
        });
      }
      document.resolve({ html: "<p>Private widget</p>", cspSandbox: "scripts" });
      const respond = await pending;
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it("reports missing documents and unavailable sandbox listeners without exposing file paths", async () => {
    const { context, invoke } = createHarness();
    readDocument.mockRejectedValueOnce(new Error("ENOENT: /private/state/canvas/secret"));
    const missing = await invoke();
    expect(missing.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(JSON.stringify(missing.mock.calls)).not.toContain("/private/state");
    context.getMcpAppSandboxPort = () => undefined;
    context.ensureSandboxHostPort = undefined;
    expect((await invoke()).mock.calls[0]?.[0]).toBe(false);
  });
});
