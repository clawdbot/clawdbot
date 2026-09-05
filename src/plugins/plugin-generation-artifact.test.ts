import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleHost } from "./plugin-module-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it.each([
  ["require.resolve", "fs.readFileSync(require.resolve('./schema.json'), 'utf8')"],
  [
    "import.meta.resolve",
    "readFileSync(new FileURL(import.meta.resolve('./schema.json')), 'utf8')",
  ],
  ["named join", "readFileSync(join(__dirname, 'schema.json'), 'utf8')"],
  ["imported URL", "readFileSync(new FileURL('./schema.json', import.meta.url), 'utf8')"],
])(
  "captures standalone imports and assets via %s without owning its workspace",
  async (_name, read) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-file-"));
    cleanups.push(() => fs.rmSync(source, { recursive: true, force: true }));
    const socket = process.platform === "win32" ? undefined : net.createServer();
    if (socket) {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(path.join(source, "socket"), resolve);
      });
    }
    try {
      fs.writeFileSync(path.join(source, "unrelated.txt"), "private workspace content");
      fs.mkdirSync(path.join(source, "unrelated"));
      fs.writeFileSync(path.join(source, "unrelated", "private.txt"), "private workspace content");
      fs.writeFileSync(
        path.join(source, "index.ts"),
        `import { token } from '@openclaw/plugin-sdk/fixture'; export { token };
       export const description = './unrelated'; export const read = async () => (await import('./helper.js')).read();`,
      );
      fs.writeFileSync(
        path.join(source, "helper.ts"),
        `import fs, { readFileSync } from 'node:fs';
       import { join } from 'node:path';
       import { URL as FileURL } from 'node:url';
       const unrelated = { resolve: (value: string) => value };
       export const label = unrelated.resolve('./unrelated.txt');
       export const read = () => [
         fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8'),
         ${read},
       ];`,
      );
      fs.writeFileSync(path.join(source, "asset.txt"), "before");
      fs.writeFileSync(path.join(source, "schema.json"), '{"version":"before"}');
      const entry = path.join(source, "index.ts");
      const captured = capturePluginGenerationArtifact(source, entry);
      cleanups.push(captured.dispose);
      const token = {};
      const requireHost = createRequire(import.meta.url);
      const host = createPluginModuleHost({
        pluginId: "file",
        rootDir: captured.boundaryRoot,
        loadHostModule: (specifier) =>
          specifier === "@openclaw/plugin-sdk/fixture" ? { token } : requireHost(specifier),
      });
      cleanups.push(host.dispose);
      const plugin = host.load(captured.resolve(entry)) as {
        read(): Promise<string[]>;
        token: unknown;
      };
      expect(plugin.token).toBe(token);
      fs.writeFileSync(path.join(source, "asset.txt"), "after");
      fs.writeFileSync(path.join(source, "schema.json"), '{"version":"after"}');
      fs.writeFileSync(
        path.join(source, "helper.ts"),
        `export const read = () => 'changed helper';`,
      );
      await expect(plugin.read()).resolves.toEqual(["before", '{"version":"before"}']);
      expect(fs.readdirSync(captured.rootDir).toSorted()).toEqual([
        "asset.txt",
        "helper.ts",
        "index.ts",
        "schema.json",
      ]);
      expect(captured.hasSource(path.join(source, "unrelated.txt"))).toBe(false);
    } finally {
      if (socket) {
        await new Promise<void>((resolve, reject) => {
          socket.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  },
);

it.each(["plugin", "punycode"])(
  "captures helpers, assets and npm packages with builtin names under %s for each reload and releases its build files",
  async (directoryName) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-source-"));
    cleanups.push(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const source = path.join(fixture, directoryName);
    const dependency = path.join(source, "node_modules", "punycode");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ dependencies: { punycode: "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "punycode", exports: { "./fixture": "./value.js" } }),
    );
    fs.writeFileSync(
      path.join(source, "index.ts"),
      `import { value } from './helper.js'; import { dependency } from 'punycode/fixture';
     export const read = async () => [value, (await import('./lazy.js')).read(), dependency];`,
    );
    fs.writeFileSync(path.join(source, "helper.js"), `export const value = 'stale build';`);
    fs.writeFileSync(
      path.join(source, "lazy.ts"),
      `import fs from 'node:fs'; export const read = () => fs.readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');`,
    );
    const load = (value: string) => {
      fs.writeFileSync(path.join(source, "helper.ts"), `export const value = '${value}';`);
      fs.writeFileSync(path.join(source, "asset.txt"), value);
      fs.writeFileSync(path.join(dependency, "value.js"), `exports.dependency = '${value}';`);
      const artifact = capturePluginGenerationArtifact(source);
      cleanups.push(artifact.dispose);
      const host = createPluginModuleHost({
        pluginId: "fixture",
        rootDir: artifact.boundaryRoot,
        loadHostModule: createRequire(import.meta.url),
      });
      cleanups.push(host.dispose);
      const plugin = host.load(artifact.resolve(path.join(source, "index.ts"))) as {
        read: () => Promise<string[]>;
      };
      return { artifact, host, plugin };
    };
    const a = load("A");
    const b = load("B");
    await expect(a.plugin.read()).resolves.toEqual(["A", "A", "A"]);
    await expect(b.plugin.read()).resolves.toEqual(["B", "B", "B"]);
    expect(a.artifact.sourceDigest).not.toBe(b.artifact.sourceDigest);
    fs.rmSync(source, { recursive: true });
    expect(b.artifact.resolve(path.join(source, "lazy.ts"))).toBe(
      path.join(b.artifact.rootDir, "lazy.ts"),
    );
    a.host.dispose();
    a.artifact.dispose();
    expect(fs.existsSync(a.artifact.boundaryRoot)).toBe(false);
    await expect(b.plugin.read()).resolves.toEqual(["B", "B", "B"]);
  },
);
