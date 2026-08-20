// Built plugin control-plane module checks cover native require(esm) acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBuiltPluginControlPlaneClosureViolations,
  listBuiltPluginControlPlaneModules,
  probeBuiltPluginControlPlaneModules,
  verifyBuiltPluginControlPlaneModules,
} from "../../scripts/check-built-plugin-control-plane-modules.mts";

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

describe("built doctor contract closures", () => {
  it("follows chunk edges to a forbidden runtime dependency", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/demo/doctor-contract-api.js",
      'import { rule } from "../../token-chunk.js";\nexport const rules = [rule];\n',
    );
    write(rootDir, "dist/token-chunk.js", 'export { rule } from "./exec-chunk.js";\n');
    write(rootDir, "dist/exec-chunk.js", 'import "execa";\nexport const rule = 1;\n');

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        {
          rootDir,
        },
      ),
    ).toEqual([
      {
        pluginId: "demo",
        kind: "doctor-contract",
        relativePath: "dist/extensions/demo/doctor-contract-api.js",
        dependency: "execa",
        importerPath: "dist/exec-chunk.js",
      },
    ]);
  });

  it("ignores lazy edges and non-doctor contract surfaces", () => {
    const rootDir = makeRoot();
    // A dynamic import is never paid at enumeration time, and the general contract
    // surface may legitimately spawn commands (matrix probes its SDK packages).
    write(
      rootDir,
      "dist/extensions/demo/doctor-contract-api.js",
      'export const load = () => import("execa");\n',
    );
    write(
      rootDir,
      "dist/extensions/demo/contract-api.js",
      'import "execa";\nexport const a = 1;\n',
    );

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        {
          rootDir,
        },
      ),
    ).toEqual([]);
  });
});

describe("built browser startup closures", () => {
  it("accepts narrow plugin registration and cleanup artifacts", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/browser/index.js",
      'export { plugin } from "../../registration-chunk.js";\n',
    );
    write(
      rootDir,
      "dist/extensions/browser/browser-proxy-upload-cleanup.runtime.js",
      'export { cleanup } from "../../cleanup-chunk.js";\n',
    );
    write(rootDir, "dist/registration-chunk.js", 'import "node:path";\nexport const plugin = 1;\n');
    write(rootDir, "dist/cleanup-chunk.js", 'import "node:fs";\nexport const cleanup = 1;\n');

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        { rootDir },
      ),
    ).toEqual([]);
  });

  it("roots the Playwright guard at the emitted Browser plugin startup entry", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/browser/index.js",
      'export { plugin } from "../../registration-chunk.js";\n',
    );
    write(
      rootDir,
      "dist/registration-chunk.js",
      'import "playwright-core/lib/server";\nexport const plugin = 1;\n',
    );

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        { rootDir },
      ),
    ).toEqual([
      {
        pluginId: "browser",
        kind: "browser-plugin-registration",
        relativePath: "dist/extensions/browser/index.js",
        dependency: "playwright-core/lib/server",
        importerPath: "dist/registration-chunk.js",
      },
    ]);
  });

  it("also guards the cleanup artifact's own emitted closure", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/browser/browser-proxy-upload-cleanup.runtime.js",
      'export { cleanup } from "../../cleanup-chunk.js";\n',
    );
    write(
      rootDir,
      "dist/cleanup-chunk.js",
      'import "playwright-core";\nexport const cleanup = 1;\n',
    );

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        { rootDir },
      ),
    ).toEqual([
      {
        pluginId: "browser",
        kind: "browser-proxy-upload-cleanup",
        relativePath: "dist/extensions/browser/browser-proxy-upload-cleanup.runtime.js",
        dependency: "playwright-core",
        importerPath: "dist/cleanup-chunk.js",
      },
    ]);
  });

  it("rejects the broad Gateway runtime from Browser startup closures", () => {
    const rootDir = makeRoot();
    write(
      rootDir,
      "dist/extensions/browser/index.js",
      'export { plugin } from "../../registration-chunk.js";\n',
    );
    write(
      rootDir,
      "dist/registration-chunk.js",
      'import "openclaw/plugin-sdk/gateway-runtime";\nexport const plugin = 1;\n',
    );

    expect(
      collectBuiltPluginControlPlaneClosureViolations(
        listBuiltPluginControlPlaneModules({ rootDir }),
        { rootDir },
      ),
    ).toEqual([
      {
        pluginId: "browser",
        kind: "browser-plugin-registration",
        relativePath: "dist/extensions/browser/index.js",
        dependency: "openclaw/plugin-sdk/gateway-runtime",
        importerPath: "dist/registration-chunk.js",
      },
    ]);
  });
});
