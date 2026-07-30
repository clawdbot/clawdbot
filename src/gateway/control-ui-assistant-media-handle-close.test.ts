import fs from "node:fs/promises";
// Regression coverage for #116346: a rejected FileHandle.close() on the assistant-media
// route must be logged, not silently swallowed, and must not break the response that
// already succeeded, or later requests on the gateway.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warnSpy = vi.fn();
let mediaRoot = "";

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const real = actual.createSubsystemLogger(subsystem);
      return {
        ...real,
        warn: (message: string, meta?: Record<string, unknown>) => warnSpy(message, meta),
      };
    },
  };
});

vi.mock("../media/local-media-access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/local-media-access.js")>();
  return { ...actual, getDefaultLocalRoots: () => [mediaRoot] };
});

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  let rejectNextClose = false;
  return {
    ...actual,
    __setRejectNextClose: (value: boolean) => {
      rejectNextClose = value;
    },
    openLocalFileSafely: async (...args: Parameters<typeof actual.openLocalFileSafely>) => {
      const opened = await actual.openLocalFileSafely(...args);
      const originalClose = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => {
        if (rejectNextClose) {
          rejectNextClose = false;
          await originalClose().catch(() => {});
          throw new Error("simulated FileHandle.close() rejection");
        }
        return originalClose();
      };
      return opened;
    },
  };
});

describe("control-ui assistant media handle close failure", () => {
  let filePath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    warnSpy.mockClear();
    mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "control-ui-handle-close-"));
    filePath = path.join(mediaRoot, "sample.txt");
    await fs.writeFile(filePath, "assistant media handle close proof\n", "utf8");

    const { handleControlUiAssistantMediaRequest } = await import("./control-ui.js");
    server = http.createServer((req, res) => {
      handleControlUiAssistantMediaRequest(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(mediaRoot, { recursive: true, force: true });
  });

  it("warns on a rejected close but still serves the request, and stays healthy for the next one", async () => {
    const fsSafe = (await import("../infra/fs-safe.js")) as unknown as {
      __setRejectNextClose: (value: boolean) => void;
    };
    const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
    const sourceParam = encodeURIComponent(filePath);

    const meta = await fetch(`${route}?meta=1&source=${sourceParam}`);
    expect(meta.status).toBe(200);
    const metaPayload = (await meta.json()) as { available?: boolean; mediaTicket?: string };
    expect(metaPayload.available).toBe(true);
    const ticket = encodeURIComponent(metaPayload.mediaTicket ?? "");

    fsSafe.__setRejectNextClose(true);
    const failing = await fetch(`${route}?source=${sourceParam}&mediaTicket=${ticket}`);

    // The response already streamed before close() runs in `finally`, so a rejected
    // close must not turn a successful response into a failure.
    expect(failing.status).toBe(200);
    expect(await failing.text()).toBe("assistant media handle close proof\n");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("simulated FileHandle.close() rejection");

    // Gateway stays usable: a later request on the same route succeeds normally, with
    // no warning this time, proving nothing was left in a broken state.
    warnSpy.mockClear();
    const healthy = await fetch(`${route}?source=${sourceParam}&mediaTicket=${ticket}`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toBe("assistant media handle close proof\n");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
