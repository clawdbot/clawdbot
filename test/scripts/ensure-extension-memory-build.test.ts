// Ensure Extension Memory Build tests cover ensure extension memory build script behavior.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureExtensionMemoryBuild,
  hasBuiltExtensionMemoryEntries,
  resolveExtensionMemoryBuildTimeoutMs,
} from "../../scripts/ensure-extension-memory-build.mts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-build-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-all.mts"), "", "utf8");
  return root;
}

function writeFixture(root: string, relativePath: string, body = "export {};\n") {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ensure-extension-memory-build", () => {
  it.each([
    "dist/extensions/external/index.js",
    "dist/extensions/external/dist/index.js",
    "extensions/external/dist/index.js",
  ])("reuses selected built entry %s without building unrelated plugins", (entry) => {
    const root = makeTempRoot();
    writeFixture(root, entry);
    writeFixture(root, "extensions/internal/openclaw.plugin.json", '{"id":"internal"}');
    writeFixture(root, "extensions/internal/index.ts");
    writeFixture(root, "extensions/external/index.ts", 'throw new Error("source imported");');

    expect(
      hasBuiltExtensionMemoryEntries({ rootDir: root, requiredExtensionIds: ["external"] }),
    ).toBe(true);

    const result = ensureExtensionMemoryBuild({
      rootDir: root,
      requiredExtensionIds: ["external"],
      spawnSync: () => {
        throw new Error("unexpected build");
      },
    });

    expect(result).toEqual({ built: false });
  });

  it.each([
    ["dist/extensions/external/index.js", ["external", "internal"]],
    ["extensions/external/dist/index.js", ["external", "internal"]],
    ["extensions/external/index.ts", ["external"]],
    ["extensions/external/dist/api.js", ["external"]],
  ])("builds when %s does not satisfy required ids %j", (entry, requiredExtensionIds) => {
    const root = makeTempRoot();
    writeFixture(root, entry);
    const params = { rootDir: root, requiredExtensionIds };
    expect(hasBuiltExtensionMemoryEntries(params)).toBe(false);
    expect(ensureExtensionMemoryBuild({ ...params, spawnSync: () => ({ status: 0 }) })).toEqual({
      built: true,
    });
  });

  it("requires all expected bundled entries by default even when local output exists", () => {
    const root = makeTempRoot();
    for (const id of ["internal-a", "internal-b", "external"]) {
      writeFixture(root, `extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
      writeFixture(root, `extensions/${id}/index.ts`);
    }
    writeFixture(
      root,
      "extensions/external/package.json",
      JSON.stringify({ openclaw: { build: { bundledDist: false } } }),
    );
    writeFixture(root, "extensions/external/dist/index.js");
    writeFixture(root, "dist/extensions/internal-a/index.js");
    expect(hasBuiltExtensionMemoryEntries({ rootDir: root, env: {} })).toBe(false);
    writeFixture(root, "dist/extensions/internal-b/index.js");
    expect(hasBuiltExtensionMemoryEntries({ rootDir: root, env: {} })).toBe(true);
  });

  it("runs the cliStartup build profile when extension entrypoints are missing", () => {
    const root = makeTempRoot();
    const calls: unknown[] = [];

    const result = ensureExtensionMemoryBuild({
      rootDir: root,
      requiredExtensionIds: ["discord"],
      nodeExecPath: "/node",
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      stdio: "pipe",
    });

    expect(result).toEqual({ built: true });
    expect(calls).toEqual([
      {
        command: "/node",
        args: ["--import", "tsx", path.join(root, "scripts", "build-all.mts"), "cliStartup"],
        options: expect.objectContaining({
          cwd: root,
          killSignal: "SIGKILL",
          stdio: "pipe",
          timeout: 10 * 60 * 1000,
        }),
      },
    ]);
  });

  it("uses the configured extension memory build timeout", () => {
    const root = makeTempRoot();
    const calls: unknown[] = [];

    ensureExtensionMemoryBuild({
      rootDir: root,
      env: { OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS: "1234" },
      requiredExtensionIds: ["discord"],
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      stdio: "pipe",
    });

    expect(calls).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({
          timeout: 1234,
        }),
      }),
    ]);
  });

  it("fails when the cliStartup build profile fails", () => {
    const root = makeTempRoot();

    expect(() =>
      ensureExtensionMemoryBuild({
        rootDir: root,
        spawnSync: () => ({ status: 1 }),
        stdio: "pipe",
      }),
    ).toThrow("cliStartup build profile failed with exit code 1");
  });
});

describe("resolveExtensionMemoryBuildTimeoutMs", () => {
  it("parses only positive integer environment timeouts", () => {
    expect(resolveExtensionMemoryBuildTimeoutMs({})).toBe(10 * 60 * 1000);
    expect(
      resolveExtensionMemoryBuildTimeoutMs({ OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS: "" }),
    ).toBe(10 * 60 * 1000);
    expect(
      resolveExtensionMemoryBuildTimeoutMs({ OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS: "4321" }),
    ).toBe(4321);

    for (const raw of ["nope", "10m", "1e3", "0", "-1", "9007199254740992"]) {
      expect(() =>
        resolveExtensionMemoryBuildTimeoutMs({
          OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS: raw,
        }),
      ).toThrow(`invalid OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS: ${raw}`);
    }
  });
});
