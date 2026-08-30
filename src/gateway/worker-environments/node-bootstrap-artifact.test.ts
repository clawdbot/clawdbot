import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeBootstrapArtifactProvider } from "./node-bootstrap-artifact.js";

const roots: string[] = [];
const providers: ReturnType<typeof createNodeBootstrapArtifactProvider>[] = [];
const buildId = "fixture-source-build";
const version = "2026.8.1";

async function write(root: string, relative: string, contents: string | object) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
}

async function fixture(mode: "source" | "package" | "external-plugin" = "source") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "node-artifact-test-")));
  roots.push(root);
  const packageRoot = path.join(root, "gateway");
  const pluginPackage = {
    name: "@fixture/remote-runtime",
    version,
    type: "module",
    dependencies: { "native-runtime": "1.2.3" },
    openclaw: { extensions: ["./index.ts"] },
  };
  const sourcePackage = {
    name: "openclaw",
    version,
    type: "module",
    files: ["dist/", "!dist/extensions/remote-runtime/**", "scripts/preinstall.mjs"],
    dependencies: { "@fixture/ai": mode === "source" ? "workspace:*" : version },
    ...(mode !== "source" ? { bundleDependencies: ["@fixture/ai"] } : {}),
    devDependencies: { "typescript-only": "workspace:*" },
    scripts: { prepare: "exit 91", prepack: "exit 92", preinstall: "node scripts/preinstall.mjs" },
  };
  await write(packageRoot, "package.json", sourcePackage);
  await write(packageRoot, "openclaw.mjs", 'import "./dist/entry.js";');
  await write(packageRoot, "node-version.mjs", "export const supported = true;");
  await write(
    packageRoot,
    "scripts/preinstall.mjs",
    'import { rmSync } from "node:fs"; rmSync(new URL("../dist/openclaw-install-guard", import.meta.url));',
  );
  await write(
    packageRoot,
    "dist/entry.js",
    'import { answer } from "./extensions/remote-runtime/index.js"; import { name } from "@fixture/ai"; console.log(`${name}:${answer}`);',
  );
  await write(packageRoot, "dist/shared.js", 'export const answer = "cloud-ready";');
  await write(packageRoot, "dist/build-info.json", { version, buildId });
  await write(packageRoot, "dist/extensions/remote-runtime/package.json", pluginPackage);
  await write(packageRoot, "dist/extensions/remote-runtime/openclaw.plugin.json", {
    id: "remote-runtime",
  });
  await write(
    packageRoot,
    "dist/extensions/remote-runtime/index.js",
    'export { answer } from "../../shared.js";',
  );
  await write(
    packageRoot,
    "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native",
    "do-not-transfer-native",
  );
  await write(packageRoot, "dist/.buildstamp", "local-build-only");
  await write(packageRoot, "dist/debug.js.map", "source-map-only");
  await write(packageRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
  await write(packageRoot, "src/private.ts", "source-only");
  await write(packageRoot, "extensions/remote-runtime/package.json", pluginPackage);
  const aiRoot =
    mode === "source"
      ? path.join(root, "ai-source")
      : path.join(packageRoot, "node_modules/@fixture/ai");
  await write(aiRoot, "package.json", {
    name: "@fixture/ai",
    version,
    type: "module",
    exports: "./dist/index.js",
  });
  await write(aiRoot, "dist/index.js", 'export const name = "local-ai";');
  if (mode === "source") {
    await fs.mkdir(path.join(packageRoot, "node_modules/@fixture"), { recursive: true });
    await fs.symlink(aiRoot, path.join(packageRoot, "node_modules/@fixture/ai"), "junction");
  }
  let pluginRoot = path.join(
    packageRoot,
    mode === "source" ? "extensions" : "dist/extensions",
    "remote-runtime",
  );
  if (mode === "external-plugin") {
    pluginRoot = path.join(root, "installed-plugin");
    await write(pluginRoot, "package.json", {
      ...pluginPackage,
      openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
    });
    await write(pluginRoot, "openclaw.plugin.json", { id: "remote-runtime" });
    await write(pluginRoot, "dist/index.js", 'export const answer = "cloud-ready";');
    await write(pluginRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
    await write(
      pluginRoot,
      "node_modules/native-runtime/vendor/host-native",
      "do-not-transfer-native",
    );
    await write(
      packageRoot,
      "dist/entry.js",
      'import { answer } from "./extensions/remote-runtime/dist/index.js"; import { name } from "@fixture/ai"; console.log(`${name}:${answer}`);',
    );
  }
  const provider = createNodeBootstrapArtifactProvider({
    packageRoot,
    runningBuildId: buildId,
    plugins: [{ id: "remote-runtime", root: pluginRoot }],
  });
  providers.push(provider);
  return { root, packageRoot, provider, sourcePackage, pluginPackage };
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("node bootstrap distribution", () => {
  it.each(["source", "package", "external-plugin"] as const)(
    "runs an unpublished %s snapshot with its plugin and private JavaScript dependency",
    async (mode) => {
      const { root, packageRoot, provider, sourcePackage } = await fixture(mode);
      const [artifact, concurrent] = await Promise.all([provider.prepare(), provider.prepare()]);
      expect(concurrent).toBe(artifact);
      expect(artifact).toMatchObject({
        buildId,
        openclawVersion: version,
        enabledPluginIds: ["remote-runtime"],
      });
      const bytes = await fs.readFile(artifact.tarballPath);
      expect(bytes.byteLength).toBe(artifact.tarballBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
      const installed = path.join(root, "node");
      await fs.mkdir(installed);
      const entries: string[] = [];
      await tar.extract({
        file: artifact.tarballPath,
        cwd: installed,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      expect(
        entries.some((entry) =>
          /(?:\.env|private\.ts|host-native|\.map|\.buildstamp)$/u.test(entry),
        ),
      ).toBe(false);
      if (mode === "external-plugin") {
        expect(entries).not.toContain("package/dist/extensions/remote-runtime/index.js");
      }
      const target = path.join(installed, "package");
      const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"));
      expect(manifest.dependencies).toEqual({ "@fixture/ai": version, "native-runtime": "1.2.3" });
      expect(manifest.bundleDependencies).toEqual(["@fixture/ai"]);
      expect(manifest.scripts).toEqual({ preinstall: "node scripts/preinstall.mjs" });
      expect(manifest.devDependencies).toBeUndefined();
      await promisify(execFile)(process.execPath, [path.join(target, "scripts/preinstall.mjs")]);
      const { stdout } = await promisify(execFile)(process.execPath, [
        path.join(target, "openclaw.mjs"),
      ]);
      expect(stdout.trim()).toBe("local-ai:cloud-ready");
      expect(JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"))).toEqual(
        sourcePackage,
      );
      expect(
        await fs.readFile(
          path.join(
            packageRoot,
            "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native",
          ),
          "utf8",
        ),
      ).toBe("do-not-transfer-native");
      await provider.close();
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(provider.prepare()).rejects.toThrow("closed");
    },
  );

  it("rejects stale running build identity before transferring a same-version distribution", async () => {
    const { packageRoot, provider } = await fixture();
    await write(packageRoot, "dist/build-info.json", { version, buildId: "newer-build" });
    await expect(provider.prepare()).rejects.toThrow("running Gateway build");
    await write(packageRoot, "dist/build-info.json", { version, buildId });
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it("retries preparation after temporary staging storage becomes available", async () => {
    const { provider } = await fixture();
    const makeTemp = vi
      .spyOn(fs, "mkdtemp")
      .mockRejectedValueOnce(new Error("temporary storage unavailable"));
    try {
      await expect(provider.prepare()).rejects.toThrow("temporary storage unavailable");
    } finally {
      makeTemp.mockRestore();
    }
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it("does not return an artifact when its lifecycle closes during preparation", async () => {
    const { provider } = await fixture();
    const pending = provider.prepare();
    const closing = provider.close();
    await expect(pending).rejects.toThrow("closed");
    await closing;
  });

  it("keeps a retired artifact until its active enrollment closes", async () => {
    const { provider } = await fixture();
    const enrollment = new AbortController();
    const artifact = await provider.prepare(enrollment.signal);
    const closing = provider.close();
    try {
      await expect(fs.access(artifact.tarballPath)).resolves.toBeUndefined();
      await expect(provider.prepare()).rejects.toThrow("closed");
    } finally {
      enrollment.abort();
      await closing;
    }
    await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retain an artifact for an enrollment cancelled during preparation", async () => {
    const { provider } = await fixture();
    const enrollment = new AbortController();
    const pending = provider.prepare(enrollment.signal);
    enrollment.abort(new Error("enrollment cancelled"));
    await expect(pending).rejects.toThrow("enrollment cancelled");
    await provider.close();
  });

  it.each(["plugin", "private runtime"])(
    "rejects an incomplete %s import closure before publishing the artifact",
    async (owner) => {
      const { packageRoot, provider } = await fixture();
      if (owner === "plugin") {
        await fs.rm(path.join(packageRoot, "dist/shared.js"));
      } else {
        const aiRoot = await fs.realpath(path.join(packageRoot, "node_modules/@fixture/ai"));
        await write(aiRoot, "dist/index.js", 'export { name } from "./missing.js";');
      }
      await expect(provider.prepare()).rejects.toThrow("incomplete built import closure");
    },
  );

  it("rejects source/built plugin dependency drift and nonexact native pins", async () => {
    const { packageRoot, provider, pluginPackage } = await fixture();
    const changed = { ...pluginPackage, dependencies: { "native-runtime": "^1.3.0" } };
    await write(packageRoot, "extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("does not match source metadata");
    await write(packageRoot, "dist/extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("requires an exact dependency pin");
  });

  it("rejects a link escaping the build tree without reading the target into the artifact", async () => {
    const { root, packageRoot, provider } = await fixture();
    await write(root, "private.json", { secret: "fixture-only" });
    await fs.symlink(path.join(root, "private.json"), path.join(packageRoot, "dist/private.json"));
    await expect(provider.prepare()).rejects.toThrow("Unsafe package dist path");
  });

  it("gives different archive identities to different built bytes with the same package version", async () => {
    const first = await fixture();
    const second = await fixture();
    await write(
      second.packageRoot,
      "dist/shared.js",
      'export const answer = "dirty-source-build";',
    );
    const [left, right] = await Promise.all([first.provider.prepare(), second.provider.prepare()]);
    expect(left.openclawVersion).toBe(right.openclawVersion);
    expect(left.tarballSha256).not.toBe(right.tarballSha256);
  });
});
