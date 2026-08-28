import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

function moduleNotFoundError(filePath: string): Error {
  return Object.assign(new Error(`Cannot find module '${filePath}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    url: pathToFileURL(filePath).href,
  });
}

describe("authenticated request dispatcher load failures", () => {
  afterEach(() => {
    vi.doUnmock("./authenticated-request-dispatch.server-methods.runtime.js");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("returns typed restart guidance when the running install changed", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "r13");
    const missingChunk = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "missing-request-dispatch-chunk.js",
    );
    const error = moduleNotFoundError(missingChunk);
    vi.resetModules();
    vi.doMock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
      get handleGatewayRequest() {
        throw error;
      },
    }));
    // Imported after doMock so the harness binds a dispatcher whose lazy runtime
    // load hits the mocked failing module.
    const { createDispatchTestHarness, createOperatorWsClient } =
      await import("./authenticated-request-dispatch.test-support.js");
    const harness = createDispatchTestHarness({ connId: "stale-install-dispatch" });
    const client = createOperatorWsClient({ connId: "stale-install-dispatch" });

    await harness.dispatcher.dispatch(
      { type: "req", id: "stale-install", method: "status", params: {} },
      client,
    );

    expect(await harness.awaitResponseFrame("stale-install")).toMatchObject({
      id: "stale-install",
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: false,
        message: expect.stringContaining("openclaw --profile r13 gateway restart"),
        details: {
          code: "STALE_INSTALL",
          restartCommand: "openclaw --profile r13 gateway restart",
        },
      },
    });
  });
});
