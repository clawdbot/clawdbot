import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveControlUiRootSyncMock, isPackageProvenControlUiRootSyncMock } = vi.hoisted(() => ({
  resolveControlUiRootSyncMock: vi.fn(),
  isPackageProvenControlUiRootSyncMock: vi.fn().mockReturnValue(true),
}));

vi.mock("../infra/control-ui-assets.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/control-ui-assets.js")>(
    "../infra/control-ui-assets.js",
  );
  return {
    ...actual,
    resolveControlUiRootSync: resolveControlUiRootSyncMock,
    isPackageProvenControlUiRootSync: isPackageProvenControlUiRootSyncMock,
  };
});

const { handleControlUiHttpRequest } = await import("./control-ui.js");
const { makeMockHttpResponse } = await import("./test-http-response.js");

async function withControlUiRoot<T>(fn: (tmp: string) => Promise<T>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-auto-root-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<html>fallback</html>\n");
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function responseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
  return String(end.mock.calls[0]?.[0] ?? "");
}

afterEach(() => {
  resolveControlUiRootSyncMock.mockReset();
  isPackageProvenControlUiRootSyncMock.mockReset();
  isPackageProvenControlUiRootSyncMock.mockReturnValue(true);
});

describe("handleControlUiHttpRequest auto-detected root", () => {
  it("serves hardlinked asset files for bundled auto-detected roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/assets/app.hl.js", method: "GET" } as IncomingMessage,
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseBody(end)).toBe("console.log('hi');");
    });
  });

  it("serves hardlinked SPA fallback index.html for bundled auto-detected roots", async () => {
    await withControlUiRoot(async (tmp) => {
      const sourceIndex = path.join(tmp, "index.source.html");
      const indexPath = path.join(tmp, "index.html");
      await fs.writeFile(sourceIndex, "<html>fallback-hardlink</html>\n");
      await fs.rm(indexPath);
      await fs.link(sourceIndex, indexPath);
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/dashboard", method: "GET" } as IncomingMessage,
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(responseBody(end)).toBe("<html>fallback-hardlink</html>\n");
    });
  });

  it("rejects hardlinked assets for non-package-proven auto-detected roots", async () => {
    isPackageProvenControlUiRootSyncMock.mockReturnValue(false);
    await withControlUiRoot(async (tmp) => {
      const assetsDir = path.join(tmp, "assets");
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
      await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));
      resolveControlUiRootSyncMock.mockReturnValue(tmp);

      const { res } = makeMockHttpResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/assets/app.hl.js", method: "GET" } as IncomingMessage,
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });
});
