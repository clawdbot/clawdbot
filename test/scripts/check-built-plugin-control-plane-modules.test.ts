// Built plugin control-plane module checks cover native require(esm) acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listBuiltPluginControlPlaneModules,
  probeBuiltPluginControlPlaneModules,
  verifyBuiltPluginControlPlaneModules,
} from "../../scripts/check-built-plugin-control-plane-modules.mjs";

const roots: string[] = [];

function makeRoot(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-control-plane-"));
  roots.push(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
  return rootDir;
}

function write(rootDir: string, relativePath: string, source: string): void {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const rootDir of roots.splice(0)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("built plugin control-plane module loads", () => {
  it("lists exact contract files and channel legacy setup references", () => {
    const rootDir = makeRoot();
    write(rootDir, "dist/extensions/demo/doctor-contract-api.js", "export const ok = true;\n");
    write(rootDir, "dist/extensions/demo/contract-api.js", "export const ok = true;\n");
    write(
      rootDir,
      "dist/extensions/demo/provider-contract-api.js",
      "export const ignored = true;\n",
    );
    write(
      rootDir,
      "dist/extensions/demo/setup-entry.js",
      [
        "const setup = {",
        '  legacyStateMigrations: { specifier: "./legacy-state-migrations-api.js" },',
        '  legacySessionSurface: { specifier: "./legacy-session-surface-api.js" },',
        "};",
        "export default setup;",
      ].join("\n"),
    );
    write(rootDir, "dist/extensions/demo/legacy-state-migrations-api.js", "export {};\n");
    write(rootDir, "dist/extensions/demo/legacy-session-surface-api.js", "export {};\n");

    expect(listBuiltPluginControlPlaneModules({ rootDir })).toEqual([
      {
        pluginId: "demo",
        kind: "contract",
        relativePath: "dist/extensions/demo/contract-api.js",
      },
      {
        pluginId: "demo",
        kind: "doctor-contract",
        relativePath: "dist/extensions/demo/doctor-contract-api.js",
      },
      {
        pluginId: "demo",
        kind: "channel-legacy-session-surface",
        relativePath: "dist/extensions/demo/legacy-session-surface-api.js",
      },
      {
        pluginId: "demo",
        kind: "channel-legacy-state-migrations",
        relativePath: "dist/extensions/demo/legacy-state-migrations-api.js",
      },
    ]);
  });

  it("accepts synchronously requireable ESM artifacts", () => {
    const rootDir = makeRoot();
    write(rootDir, "dist/extensions/demo/doctor-contract-api.js", "export const ok = true;\n");

    expect(() => verifyBuiltPluginControlPlaneModules({ rootDir })).not.toThrow();
  });

  it("reports plugin, kind, path, and native require error", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/demo/doctor-contract-api.js",
      "await Promise.resolve();\nexport const ok = true;\n",
    );

    expect(() => verifyBuiltPluginControlPlaneModules({ rootDir })).toThrow(
      /demo \(doctor-contract\) dist\/extensions\/demo\/doctor-contract-api\.js:.*ERR_REQUIRE_ASYNC_MODULE/s,
    );
  });

  it("bounds a stalled native require child", () => {
    const rootDir = makeRoot();
    write(rootDir, "dist/extensions/demo/doctor-contract-api.js", "while (true) {}\n");
    const modules = listBuiltPluginControlPlaneModules({ rootDir });

    expect(() => probeBuiltPluginControlPlaneModules(modules, { rootDir, timeoutMs: 100 })).toThrow(
      /timed out|ETIMEDOUT/u,
    );
  });
});
