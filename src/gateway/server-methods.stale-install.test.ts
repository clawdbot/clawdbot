import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";

function moduleNotFoundError(filePath: string): Error {
  return Object.assign(new Error(`Cannot find module '${filePath}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    url: pathToFileURL(filePath).href,
  });
}

async function dispatchThrowingHandler(error: Error, respond = vi.fn()) {
  await handleGatewayRequest({
    req: { type: "req", id: "stale-install", method: "test.stale-install" },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
    extraHandlers: {
      "test.stale-install": async () => {
        throw error;
      },
    },
  });
  return respond;
}

describe("gateway stale install errors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("turns a missing module from the OpenClaw install into restart guidance", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "sd1");
    const missingChunk = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "missing-own-chunk.js",
    );
    const respond = await dispatchThrowingHandler(moduleNotFoundError(missingChunk));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: false,
        message: expect.stringContaining("openclaw --profile sd1 gateway restart"),
        details: {
          code: "STALE_INSTALL",
          restartCommand: "openclaw --profile sd1 gateway restart",
        },
      }),
    );
  });

  it("does not rewrite a missing module outside the OpenClaw install", async () => {
    const outsideInstall = path.join(
      path.parse(process.cwd()).root,
      "outside-openclaw",
      "missing.js",
    );
    const error = moduleNotFoundError(outsideInstall);
    const respond = vi.fn();

    await expect(dispatchThrowingHandler(error, respond)).rejects.toBe(error);
    expect(respond).not.toHaveBeenCalled();
  });
});
