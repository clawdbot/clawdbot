// Hook module loader tests cover dynamic import and export resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importFileModule, resolveFunctionModuleExport } from "./module-loader.js";

describe("hooks module loader helpers", () => {
  it("imports file modules and bypasses the module cache when requested", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-module-loader-"));
    const modulePath = path.join(root, "hook handler.mjs");
    try {
      fs.writeFileSync(modulePath, 'export const value = "first";\n');
      await expect(importFileModule({ modulePath })).resolves.toMatchObject({ value: "first" });

      fs.writeFileSync(modulePath, 'export const value = "second";\n');
      await expect(
        importFileModule({ modulePath, cacheBust: true, nowMs: 123 }),
      ).resolves.toMatchObject({ value: "second" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
