import { afterEach, expect, it, vi } from "vitest";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";

afterEach(() => {
  document.documentElement.removeAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each(["verified update", "terminal policy change"])(
  "retains unsaved starts when a %s would reload the document",
  async (cause) => {
    vi.resetModules();
    vi.stubGlobal(
      "OPENCLAW_CONTROL_UI_BUILD_INFO",
      normalizeControlUiBuildInfo({ version: "2026.9.4", buildId: "current-document" }),
    );
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { origin: "http://localhost", reload } });
    const { registerControlUiReloadGuard } = await import("./document-reload-guard.ts");
    const release = registerControlUiReloadGuard(() => false, vi.fn());
    try {
      let attempt: () => Promise<unknown>;
      if (cause === "verified update") {
        const { reloadControlUiIfStale } = await import("../build-info.ts");
        attempt = async () => reloadControlUiIfStale({ version: "2026.9.5", sha: null });
      } else {
        document.documentElement.setAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE, "false");
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json({ terminalEnabled: true })),
        );
        const { createApplicationConfigCapability } = await import("./config.ts");
        const config = createApplicationConfigCapability({ resourceBasePath: "" });
        attempt = async () => {
          const result = await config.refresh();
          expect(result).toMatchObject({ terminalEnabled: true });
          // The existing document keeps its policy until a fresh document can load.
          expect(config.current.terminalEnabled).toBe(false);
          return result;
        };
      }
      await attempt();
      expect(reload).not.toHaveBeenCalled();
      release();
      await attempt();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  },
);
