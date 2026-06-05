// Hook module loader tests cover dynamic import and invalid module handling.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveFileModuleUrl, resolveFunctionModuleExport } from "./module-loader.js";

describe("hooks module loader helpers", () => {
  it("builds a file URL without cache-busting by default", () => {
    const modulePath = path.resolve("/tmp/hook-handler.js");
    expect(resolveFileModuleUrl({ modulePath })).toBe(pathToFileURL(modulePath).href);
  });

  it("adds a cache-busting query when requested", () => {
    const modulePath = path.resolve("/tmp/hook-handler.js");
    expect(
      resolveFileModuleUrl({
        modulePath,
        cacheBust: true,
        nowMs: 123,
      }),
    ).toBe(`${pathToFileURL(modulePath).href}?t=123`);
  });

  it("resolves explicit function exports", () => {
    const fn = () => "ok";
    const resolved = resolveFunctionModuleExport({
      mod: { run: fn },
      exportName: "run",
    });
    expect(resolved).toBe(fn);
  });

  it("falls back through named exports when no explicit export is provided", () => {
    const fallback = () => "ok";
    const resolved = resolveFunctionModuleExport({
      mod: { transform: fallback },
      fallbackExportNames: ["default", "transform"],
    });
    expect(resolved).toBe(fallback);
  });

  it("returns undefined when export exists but is not callable", () => {
    const resolved = resolveFunctionModuleExport({
      mod: { run: "nope" },
      exportName: "run",
    });
    expect(resolved).toBeUndefined();
  });
});
