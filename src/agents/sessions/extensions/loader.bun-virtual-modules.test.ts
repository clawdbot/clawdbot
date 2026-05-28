import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const jitiCalls = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("jiti/static", () => ({
  createJiti: vi.fn((_url: string, options: Record<string, unknown>) => {
    jitiCalls.options.push(options);
    return {
      import: vi.fn(
        async () => async (api: { registerCommand: (id: string, command: unknown) => void }) => {
          api.registerCommand("bun-virtual-module-probe", {
            description: "probe",
            handler() {},
          });
        },
      ),
    };
  }),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isBunBinary: true };
});

const tempDirs: string[] = [];

afterEach(async () => {
  jitiCalls.options.length = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadExtensions in Bun binary mode", () => {
  it("virtualizes scoped and unscoped SDK module ids", async () => {
    const { loadExtensions } = await import("./loader.js");
    const dir = await mkdtemp(join(tmpdir(), "openclaw-extension-sdk-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "extension.ts");
    await writeFile(extensionPath, "export default function extension() {}\n");

    const result = await loadExtensions([extensionPath], dir);

    expect(result.errors).toEqual([]);
    expect(jitiCalls.options).toHaveLength(1);
    const virtualModules = jitiCalls.options[0]?.virtualModules as Record<string, unknown>;
    expect(Object.keys(virtualModules)).toEqual(
      expect.arrayContaining([
        "openclaw/plugin-sdk/agent-core",
        "@openclaw/plugin-sdk/agent-core",
        "openclaw/plugin-sdk/llm",
        "@openclaw/plugin-sdk/llm",
        "openclaw/plugin-sdk/agent-sessions",
        "@openclaw/plugin-sdk/agent-sessions",
      ]),
    );
  });
});
