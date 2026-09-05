// Built plugin control-plane module checks cover native require(esm) acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBuiltDoctorContractClosureViolations,
  listBuiltPluginControlPlaneModules,
  probeBuiltPluginControlPlaneModules,
  verifyBuiltPluginControlPlaneModules,
} from "../../scripts/check-built-plugin-control-plane-modules.mts";

const roots: string[] = [];

function makeRoot(extension = ".js"): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-control-plane-"));
  roots.push(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}\n');
  if (extension === ".cjs") {
    write(rootDir, "extensions/demo/openclaw.plugin.json", '{"id":"demo"}');
    write(rootDir, "extensions/demo/index.ts", "export {};\n");
    write(
      rootDir,
      "extensions/demo/package.json",
      JSON.stringify({
        openclaw: {
          extensions: ["./index.ts"],
          build: { bundledDist: false, runtimeFormat: "cjs" },
          release: { publishToNpm: true },
        },
      }),
    );
  }
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
  it.each([".js", ".cjs"])(
    "lists exact %s contracts and channel legacy setup references",
    (extension) => {
      const rootDir = makeRoot(extension);
      write(
        rootDir,
        `dist/extensions/demo/doctor-contract-api${extension}`,
        "export const ok = true;\n",
      );
      write(rootDir, `dist/extensions/demo/contract-api${extension}`, "export const ok = true;\n");
      write(
        rootDir,
        `dist/extensions/demo/provider-contract-api${extension}`,
        "export const ignored = true;\n",
      );
      write(
        rootDir,
        `dist/extensions/demo/setup-entry${extension}`,
        [
          "const setup = {",
          `  legacyStateMigrations: { specifier: "./legacy-state-migrations-api${extension}" },`,
          `  legacySessionSurface: { specifier: "./legacy-session-surface-api${extension}" },`,
          "};",
          "export default setup;",
        ].join("\n"),
      );
      write(
        rootDir,
        `dist/extensions/demo/legacy-state-migrations-api${extension}`,
        "export {};\n",
      );
      write(rootDir, `dist/extensions/demo/legacy-session-surface-api${extension}`, "export {};\n");

      expect(listBuiltPluginControlPlaneModules({ rootDir })).toEqual([
        {
          pluginId: "demo",
          kind: "contract",
          relativePath: `dist/extensions/demo/contract-api${extension}`,
        },
        {
          pluginId: "demo",
          kind: "doctor-contract",
          relativePath: `dist/extensions/demo/doctor-contract-api${extension}`,
        },
        {
          pluginId: "demo",
          kind: "channel-legacy-session-surface",
          relativePath: `dist/extensions/demo/legacy-session-surface-api${extension}`,
        },
        {
          pluginId: "demo",
          kind: "channel-legacy-state-migrations",
          relativePath: `dist/extensions/demo/legacy-state-migrations-api${extension}`,
        },
      ]);
    },
  );

  it.each([".js", ".cjs"])("accepts synchronously requireable %s artifacts", (extension) => {
    const rootDir = makeRoot(extension);
    write(
      rootDir,
      `dist/extensions/demo/doctor-contract-api${extension}`,
      extension === ".cjs" ? "exports.ok = true;\n" : "export const ok = true;\n",
    );

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
  it.each([".js", ".cjs"])(
    "follows %s chunk edges to a forbidden runtime dependency",
    (extension) => {
      const rootDir = makeRoot(extension);
      write(
        rootDir,
        `dist/extensions/demo/doctor-contract-api${extension}`,
        extension === ".cjs"
          ? 'module.exports = require("../../token-chunk.cjs");'
          : 'export * from "../../token-chunk.js";',
      );
      write(
        rootDir,
        `dist/token-chunk${extension}`,
        extension === ".cjs"
          ? 'module.exports = require("./exec-chunk.cjs");'
          : 'export * from "./exec-chunk.js";',
      );
      write(
        rootDir,
        `dist/exec-chunk${extension}`,
        extension === ".cjs"
          ? 'const exec = require("execa"); exports.rule = exec;'
          : 'import "execa"; export const rule = 1;',
      );

      expect(
        collectBuiltDoctorContractClosureViolations(
          listBuiltPluginControlPlaneModules({ rootDir }),
          { rootDir },
        ),
      ).toEqual([
        {
          pluginId: "demo",
          kind: "doctor-contract",
          relativePath: `dist/extensions/demo/doctor-contract-api${extension}`,
          dependency: "execa",
          importerPath: `dist/exec-chunk${extension}`,
        },
      ]);
    },
  );

  it.each([".js", ".cjs"])(
    "ignores lazy %s edges and non-doctor contract surfaces",
    (extension) => {
      const rootDir = makeRoot(extension);
      // A dynamic import is never paid at enumeration time, and the general contract
      // surface may legitimately spawn commands (matrix probes its SDK packages).
      write(
        rootDir,
        `dist/extensions/demo/doctor-contract-api${extension}`,
        extension === ".cjs"
          ? 'exports.load = () => require("execa");'
          : 'export const load = () => import("execa");',
      );
      write(
        rootDir,
        `dist/extensions/demo/contract-api${extension}`,
        extension === ".cjs"
          ? 'require("execa"); exports.a = 1;'
          : 'import "execa"; export const a = 1;',
      );

      expect(
        collectBuiltDoctorContractClosureViolations(
          listBuiltPluginControlPlaneModules({ rootDir }),
          {
            rootDir,
          },
        ),
      ).toEqual([]);
    },
  );
});
