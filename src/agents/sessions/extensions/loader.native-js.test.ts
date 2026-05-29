import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jitiCalls = vi.hoisted(() => ({
  imports: [] as string[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("jiti/static", () => ({
  createJiti: vi.fn((_url: string, options: Record<string, unknown>) => {
    jitiCalls.options.push(options);
    return {
      import: vi.fn(async (target: string) => {
        jitiCalls.imports.push(target);
        return async (api: { registerCommand: (id: string, command: unknown) => void }) => {
          api.registerCommand(`jiti-${jitiCalls.imports.length}`, {
            description: "probe",
            handler() {},
          });
        };
      }),
    };
  }),
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  jitiCalls.imports.length = 0;
  jitiCalls.options.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensions native JavaScript path", () => {
  it("loads compiled JavaScript extensions without creating a jiti loader", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.mjs");
    await writeFile(
      extensionPath,
      `
export default async function extension(api) {
  api.registerCommand("native-js-probe", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("native-js-probe")).toBe(true);
    expect(jitiCalls.options).toEqual([]);
    expect(jitiCalls.imports).toEqual([]);
  });

  it("reloads native JavaScript extensions when the file changes without stat-key drift", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.cjs");
    const beforeSource = `
module.exports = async function(api) {
  api.registerCommand("native-reload-one", {
    description: "probe",
    handler() {},
  });
};
`;
    const afterSource = `
module.exports = async function(api) {
  api.registerCommand("native-reload-two", {
    description: "probe",
    handler() {},
  });
};
`;
    expect(afterSource).toHaveLength(beforeSource.length);
    await writeFile(extensionPath, beforeSource);

    const before = await loadExtensions([extensionPath], dir);
    const beforeStat = await stat(extensionPath);

    await writeFile(extensionPath, afterSource);
    await utimes(extensionPath, beforeStat.atime, beforeStat.mtime);
    const after = await loadExtensions([extensionPath], dir);

    expect(before.errors).toEqual([]);
    expect(before.extensions[0]?.commands.has("native-reload-one")).toBe(true);
    expect(after.errors).toEqual([]);
    expect(after.extensions[0]?.commands.has("native-reload-two")).toBe(true);
    expect(jitiCalls.options).toEqual([]);
  });

  it("loads transpiled CommonJS default exports through the native path", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.cjs");
    await writeFile(
      extensionPath,
      `
exports.default = async function(api) {
  api.registerCommand("native-cjs-default-probe", {
    description: "probe",
    handler() {},
  });
};
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.commands.has("native-cjs-default-probe")).toBe(true);
    expect(jitiCalls.options).toEqual([]);
  });

  it("keeps CommonJS-shaped .js extensions on jiti", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    const extensionPath = join(dir, "extension.js");
    await writeFile(
      extensionPath,
      `
module.exports = async function(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
};
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });

  it("keeps plain ESM .js extensions on jiti", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.js");
    await writeFile(
      extensionPath,
      `
export default async function extension(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
}
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });

  it("keeps SDK-alias JavaScript extensions on one shared jiti loader", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const firstPath = join(dir, "first.js");
    const secondPath = join(dir, "second.js");
    const source = `
require("@openclaw/plugin-sdk/agent-sessions");
module.exports = async function(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
};
`;
    await writeFile(firstPath, source);
    await writeFile(secondPath, source);

    const result = await loadExtensions([firstPath, secondPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(2);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([firstPath, secondPath]);
  });

  it("keeps TypeBox-alias JavaScript extensions on jiti", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.js");
    await writeFile(
      extensionPath,
      `
require("typebox");
module.exports = async function(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
};
`,
    );

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });

  it("keeps multi-file JavaScript extensions on jiti for graph-wide aliases", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.js");
    await writeFile(
      extensionPath,
      `
require("./helper.js");
module.exports = async function(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
};
`,
    );
    await writeFile(join(dir, "helper.js"), 'require("typebox");\n');

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });

  it("keeps ESM re-export JavaScript extensions on jiti for graph-wide aliases", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    const extensionPath = join(dir, "extension.js");
    await writeFile(
      extensionPath,
      `
export { helper } from "./helper.js";
export default async function extension(api) {
  api.registerCommand("should-not-native-load", {
    description: "probe",
    handler() {},
  });
}
`,
    );
    await writeFile(join(dir, "helper.js"), 'import "typebox"; export const helper = true;\n');

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });

  it("keeps minified ESM relative imports on jiti for graph-wide aliases", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-js-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.mjs");
    await writeFile(
      extensionPath,
      `import{helper}from"./helper.mjs";export{helper}from"./helper.mjs";export default async function extension(api){api.registerCommand("should-not-native-load",{description:"probe",handler(){}});}`,
    );
    await writeFile(join(dir, "helper.mjs"), 'import "typebox"; export const helper = true;\n');

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(jitiCalls.options).toHaveLength(1);
    expect(jitiCalls.imports).toEqual([extensionPath]);
  });
});
