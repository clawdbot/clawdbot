import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BundledRuntimeDepsInstallParams } from "./bundled-runtime-deps-install.js";
import { resolveBundledRuntimeDependencyInstallRoot } from "./bundled-runtime-deps-roots.js";
import { materializeBundledRuntimeMirrorFile } from "./bundled-runtime-mirror.js";
import {
  clearPreparedBundledPluginRuntimeLoadRoots,
  prepareBundledPluginRuntimeLoadRoot,
  prepareBundledPluginRuntimeRoot,
} from "./bundled-runtime-root.js";
import {
  writeGeneratedRuntimeDepsManifest,
  writeInstalledRuntimeDepPackage,
} from "./test-helpers/bundled-runtime-deps-fixtures.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-root-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPreparedBundledPluginRuntimeLoadRoots();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFilesystemTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBigIntStatOptions(options: unknown): boolean {
  return Boolean(
    options && typeof options === "object" && "bigint" in options && options.bigint === true,
  );
}

describe("prepareBundledPluginRuntimeRoot", () => {
  it("keeps existing materialized root chunks when copy refresh fails", () => {
    const root = makeTempRoot();
    const source = path.join(root, "source.js");
    const target = path.join(root, "mirror", "source.js");
    fs.writeFileSync(source, "export const value = 'new';\n", "utf8");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const value = 'old';\n", "utf8");
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("EXDEV");
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    expect(() => materializeBundledRuntimeMirrorFile(source, target)).toThrow("ENOSPC");
    expect(fs.readFileSync(target, "utf8")).toBe("export const value = 'old';\n");
  });

  it("reuses existing hardlinked mirror files without rewriting them", () => {
    const root = makeTempRoot();
    const source = path.join(root, "source.js");
    const target = path.join(root, "mirror", "source.js");
    fs.writeFileSync(source, "export const value = 'stable';\n", "utf8");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.linkSync(source, target);
    const initialTargetStat = fs.statSync(target, { bigint: true });

    const linkSpy = vi.spyOn(fs, "linkSync");
    const copySpy = vi.spyOn(fs, "copyFileSync");
    const removeSpy = vi.spyOn(fs, "rmSync");

    materializeBundledRuntimeMirrorFile(source, target);

    const reusedTargetStat = fs.statSync(target, { bigint: true });
    expect(reusedTargetStat.dev).toBe(initialTargetStat.dev);
    expect(reusedTargetStat.ino).toBe(initialTargetStat.ino);
    expect(linkSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("materializes root JavaScript chunks in external mirrors", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.24", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "pw-ai.js"),
      [
        `//#region extensions/browser/src/pw-ai.ts`,
        `import { marker } from "playwright-core";`,
        `export { marker };`,
        `//#endregion`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "shared-runtime.js"),
      "export const shared = 'mirrored-without-region';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "config-runtime.js"),
      "import JSON5 from 'json5'; export const parse = JSON5.parse;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "string-runtime.js"),
      `const text = 'not an import: from "zod"'; export const marker = text;\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../pw-ai.js"; export default { id: "browser", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/browser",
          version: "1.0.0",
          type: "module",
          dependencies: {
            "playwright-core": "1.0.0",
          },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const depRoot = path.join(installRoot, "node_modules", "playwright-core");
    fs.mkdirSync(depRoot, { recursive: true });
    fs.writeFileSync(
      path.join(depRoot, "package.json"),
      JSON.stringify({
        name: "playwright-core",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(depRoot, "index.js"), "export const marker = 'stage-ok';\n", "utf8");
    writeGeneratedRuntimeDepsManifest(installRoot, ["playwright-core@1.0.0"]);

    const staleMirrorChunk = path.join(installRoot, "dist", "pw-ai.js");
    fs.mkdirSync(path.dirname(staleMirrorChunk), { recursive: true });
    fs.symlinkSync(path.join(packageRoot, "dist", "pw-ai.js"), staleMirrorChunk, "file");

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(path.join(installRoot, "dist", "extensions", "browser"));
    expect(prepared.modulePath).toBe(path.join(prepared.pluginRoot, "index.js"));
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);

    const preparedAgain = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot: prepared.pluginRoot,
      modulePath: prepared.modulePath,
      env,
    });

    expect(preparedAgain).toEqual(prepared);
    expect(fs.existsSync(staleMirrorChunk)).toBe(true);
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(staleMirrorChunk, "utf8")).toContain("playwright-core");
    expect(fs.lstatSync(path.join(installRoot, "dist", "shared-runtime.js")).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.lstatSync(path.join(installRoot, "dist", "config-runtime.js")).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.lstatSync(path.join(installRoot, "dist", "string-runtime.js")).isSymbolicLink()).toBe(
      false,
    );
  });

  it("reuses prepared root mirrors across bundled plugins", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    const rootChunk = path.join(packageRoot, "dist", "shared-runtime.js");
    const externalChunk = path.join(packageRoot, "dist", "external-runtime.js");
    fs.mkdirSync(path.join(packageRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(rootChunk, "export const shared = 'root';\n", "utf8");
    fs.writeFileSync(externalChunk, "import zod from 'zod'; export const schema = zod;\n", "utf8");
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(
      path.join(packageRoot, "dist", "extensions", "alpha"),
      { env },
    );

    for (const pluginId of ["alpha", "beta"]) {
      const pluginRoot = path.join(packageRoot, "dist", "extensions", pluginId);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, "index.js"),
        `import { shared } from "../../shared-runtime.js"; export default { id: ${JSON.stringify(pluginId)}, shared };\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify(
          {
            name: `@openclaw/${pluginId}`,
            version: "1.0.0",
            type: "module",
            dependencies: { [`${pluginId}-runtime`]: "1.0.0" },
            openclaw: { extensions: ["./index.js"] },
          },
          null,
          2,
        ),
        "utf8",
      );
      const pluginInstallRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
      fs.mkdirSync(path.join(pluginInstallRoot, "node_modules", `${pluginId}-runtime`), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(pluginInstallRoot, "node_modules", `${pluginId}-runtime`, "package.json"),
        JSON.stringify({ name: `${pluginId}-runtime`, version: "1.0.0", type: "module" }),
        "utf8",
      );
    }
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0", "beta-runtime@1.0.0"]);

    const realReaddirSync = fs.readdirSync.bind(fs);
    const readdirPaths: string[] = [];
    vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) => {
      const targetPath = target.toString();
      if (
        targetPath === path.join(packageRoot, "dist") &&
        new Error().stack?.includes("mirrorBundledRuntimeDistRootEntries")
      ) {
        readdirPaths.push(targetPath);
      }
      return realReaddirSync(target, options as never);
    }) as typeof fs.readdirSync);

    for (const pluginId of ["alpha", "beta"]) {
      const pluginRoot = path.join(packageRoot, "dist", "extensions", pluginId);
      prepareBundledPluginRuntimeRoot({
        pluginId,
        pluginRoot,
        modulePath: path.join(pluginRoot, "index.js"),
        env,
      });
    }

    expect(fs.lstatSync(path.join(installRoot, "dist", "shared-runtime.js")).isSymbolicLink()).toBe(
      false,
    );
    expect(
      fs.lstatSync(path.join(installRoot, "dist", "external-runtime.js")).isSymbolicLink(),
    ).toBe(false);
    expect(readdirPaths).toHaveLength(1);
  });

  it("does not memoize source-checkout dist mirrors", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(packageRoot, "dist", "shared-runtime.js"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import "../../shared-runtime.js"; export default { id: "alpha" };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/alpha",
          version: "1.0.0",
          type: "module",
          dependencies: { "alpha-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "alpha-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "alpha-runtime", "package.json"),
      JSON.stringify({ name: "alpha-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["alpha-runtime@1.0.0"]);

    const realReaddirSync = fs.readdirSync.bind(fs);
    const readdirPaths: string[] = [];
    vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) => {
      const targetPath = target.toString();
      if (
        targetPath === path.join(packageRoot, "dist") &&
        new Error().stack?.includes("mirrorBundledRuntimeDistRootEntries")
      ) {
        readdirPaths.push(targetPath);
      }
      return realReaddirSync(target, options as never);
    }) as typeof fs.readdirSync);

    for (let index = 0; index < 2; index += 1) {
      prepareBundledPluginRuntimeRoot({
        pluginId: "alpha",
        pluginRoot,
        modulePath: path.join(pluginRoot, "index.js"),
        env,
      });
    }

    expect(readdirPaths).toHaveLength(2);
  });

  it("does not copy staged runtime mirror dist files onto themselves", () => {
    const stageDir = makeTempRoot();
    const installRoot = path.join(stageDir, "openclaw-2026.4.26-alpha");
    const pluginRoot = path.join(installRoot, "dist", "extensions", "qqbot");
    const distChunk = path.join(installRoot, "dist", "accounts-abc123.js");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.26", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(distChunk, "export const marker = 'same-root';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../accounts-abc123.js"; export default { id: "qqbot", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["qqbot-runtime@1.0.0"]);

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(pluginRoot);
    expect(prepared.modulePath).toBe(path.join(pluginRoot, "index.js"));
    expect(fs.readFileSync(distChunk, "utf8")).toContain("same-root");
  });

  it("mirrors canonical dist chunks when loading from dist-runtime", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const canonicalPluginRoot = path.join(packageRoot, "dist", "extensions", "qqbot");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "qqbot");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(canonicalPluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "onboard-abc123.js"),
      "export const setup = 'canonical-setup';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "index.js"),
      `import { setup } from "../../onboard-abc123.js"; export default { id: "qqbot", setup };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "index.js"),
      [
        "export { default } ",
        "from ",
        JSON.stringify("../../../dist/extensions/qqbot/index.js"),
        ";\n",
      ].join(""),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["qqbot-runtime@1.0.0"]);

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(path.join(installRoot, "dist-runtime", "extensions", "qqbot"));
    expect(fs.existsSync(path.join(installRoot, "dist", "onboard-abc123.js"))).toBe(true);
    expect(
      fs.readFileSync(path.join(installRoot, "dist", "extensions", "qqbot", "index.js"), "utf8"),
    ).toContain("onboard-abc123");
  });

  it("fingerprints runtime mirror source roots before taking the mirror lock", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const canonicalPluginRoot = path.join(packageRoot, "dist", "extensions", "qqbot");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "qqbot");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(canonicalPluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "index.js"),
      "export default { id: 'qqbot' };\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/qqbot", version: "1.0.0", type: "module" }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "index.js"),
      `export { default } from ${JSON.stringify("../../../dist/extensions/qqbot/index.js")};\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["qqbot-runtime@1.0.0"]);

    const lockPath = path.join(installRoot, ".openclaw-runtime-mirror.lock");
    const fingerprintLockStates: Array<{ source: "runtime" | "canonical"; locked: boolean }> = [];
    const realLstatSync = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const targetPath = target.toString();
      if (isBigIntStatOptions(options)) {
        if (isPathInsideRoot(targetPath, runtimePluginRoot)) {
          fingerprintLockStates.push({ source: "runtime", locked: fs.existsSync(lockPath) });
        } else if (isPathInsideRoot(targetPath, canonicalPluginRoot)) {
          fingerprintLockStates.push({ source: "canonical", locked: fs.existsSync(lockPath) });
        }
      }
      return realLstatSync(target, options as never);
    }) as typeof fs.lstatSync);

    prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    expect(fingerprintLockStates.some((entry) => entry.source === "runtime")).toBe(true);
    expect(fingerprintLockStates.some((entry) => entry.source === "canonical")).toBe(true);
    expect(fingerprintLockStates.filter((entry) => entry.locked)).toEqual([]);
  });

  it("reuses unchanged external runtime mirrors from the original plugin root", async () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v1';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          type: "module",
          dependencies: { "whatsapp-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "whatsapp-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "whatsapp-runtime", "package.json"),
      JSON.stringify({ name: "whatsapp-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["whatsapp-runtime@1.0.0"]);

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const mirrorEntry = path.join(prepared.pluginRoot, "index.js");
    const initialStat = fs.statSync(mirrorEntry);

    await waitForFilesystemTimestampTick();

    const preparedAgain = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const reusedStat = fs.statSync(mirrorEntry);

    expect(preparedAgain).toEqual(prepared);
    expect(reusedStat.mtimeMs).toBe(initialStat.mtimeMs);
    expect(fs.readFileSync(mirrorEntry, "utf8")).toContain("v1");
  });

  it("verifies runtime deps before returning a memoized prepared root", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v1';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          type: "module",
          dependencies: { "whatsapp-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const installDeps = vi.fn((installParams: BundledRuntimeDepsInstallParams) => {
      const installSpecs = installParams.installSpecs ?? [];
      for (const spec of installSpecs) {
        const atIndex = spec.lastIndexOf("@");
        writeInstalledRuntimeDepPackage(
          installParams.installRoot,
          spec.slice(0, atIndex),
          spec.slice(atIndex + 1),
        );
      }
      writeGeneratedRuntimeDepsManifest(installParams.installRoot, installSpecs);
    });

    const prepared = prepareBundledPluginRuntimeLoadRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
      installDeps,
      memoizePreparedRoot: true,
    });
    fs.rmSync(path.join(installRoot, "node_modules"), { recursive: true, force: true });
    fs.rmSync(path.join(installRoot, "package.json"), { force: true });

    const preparedAgain = prepareBundledPluginRuntimeLoadRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
      installDeps,
      memoizePreparedRoot: true,
    });

    expect(preparedAgain).toEqual(prepared);
    expect(installDeps).toHaveBeenCalledTimes(2);
  });

  it("includes earlier staging failures when verify-only runtime deps still fail", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@openclaw/whatsapp",
        version: "1.0.0",
        type: "module",
        dependencies: { "whatsapp-runtime": "1.0.0" },
      }),
      "utf8",
    );

    expect(() =>
      prepareBundledPluginRuntimeRoot({
        pluginId: "whatsapp",
        pluginRoot,
        modulePath: path.join(pluginRoot, "index.js"),
        env,
        installMissingDeps: false,
        previousRepairError: new Error("offline registry"),
      }),
    ).toThrow(
      /bundled runtime dependencies missing.*whatsapp-runtime@1\.0\.0.*previous bundled runtime dependency staging failure: offline registry/s,
    );
  });

  it("refreshes external runtime mirrors when source files change", async () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v1';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          type: "module",
          dependencies: { "whatsapp-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "whatsapp-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "whatsapp-runtime", "package.json"),
      JSON.stringify({ name: "whatsapp-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeGeneratedRuntimeDepsManifest(installRoot, ["whatsapp-runtime@1.0.0"]);

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const mirrorEntry = path.join(prepared.pluginRoot, "index.js");
    const initialStat = fs.statSync(mirrorEntry);

    await waitForFilesystemTimestampTick();
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v2';\n", "utf8");

    prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const refreshedStat = fs.statSync(mirrorEntry);

    expect(refreshedStat.mtimeMs).toBeGreaterThan(initialStat.mtimeMs);
    expect(fs.readFileSync(mirrorEntry, "utf8")).toContain("v2");
  });
});
