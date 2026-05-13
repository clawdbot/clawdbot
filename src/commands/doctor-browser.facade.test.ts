import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { noteChromeMcpBrowserReadiness } from "./doctor-browser.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

function requireFirstNoteCall(noteFn: ReturnType<typeof vi.fn>): unknown[] {
  const call = noteFn.mock.calls[0];
  if (!call) {
    throw new Error("expected browser doctor note");
  }
  return call;
}

describe("doctor browser facade", () => {
  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("delegates browser readiness checks to the browser facade surface", async () => {
    const delegate = vi.fn().mockResolvedValue(undefined);
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      noteChromeMcpBrowserReadiness: delegate,
    });

    const cfg: OpenClawConfig = {
      browser: {
        defaultProfile: "user",
      },
    };
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(cfg, { noteFn });

    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-doctor.js",
    });
    expect(delegate).toHaveBeenCalledWith(cfg, { noteFn });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns and no-ops when the browser doctor surface is unavailable", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("missing browser doctor facade");
    });

    const noteFn = vi.fn();

    await expect(noteChromeMcpBrowserReadiness({}, { noteFn })).resolves.toBeUndefined();
    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(requireFirstNoteCall(noteFn)).toEqual([
      "- Browser health check is unavailable: missing browser doctor facade",
      "Browser",
    ]);
  });
});
