import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CircularIncludeError,
  ConfigIncludeError,
  type IncludeResolver,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_CLAWDBOT_DIR = path.join(ROOT_DIR, "etc", "clawdbot");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "clawdbot.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcClawdbotPath(...parts: string[]) {
  return path.join(ETC_CLAWDBOT_DIR, ...parts);
}

function sharedPath(...parts: string[]) {
  return path.join(SHARED_DIR, ...parts);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(
  obj: unknown,
  files: Record<string, unknown> = {},
  basePath = DEFAULT_BASE_PATH,
) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

describe("resolveConfigIncludes", () => {
  it("passes through primitives unchanged", () => {
    expect(resolve("hello")).toBe("hello");
    expect(resolve(42)).toBe(42);
    expect(resolve(true)).toBe(true);
    expect(resolve(null)).toBe(null);
  });

  it("passes through arrays with recursion", () => {
    expect(resolve([1, 2, { a: 1 }])).toEqual([1, 2, { a: 1 }]);
  });

  it("passes through objects without $include", () => {
    const obj = { foo: "bar", nested: { x: 1 } };
    expect(resolve(obj)).toEqual(obj);
  });

  it("resolves single file $include", () => {
    const files = { [configPath("agents.json")]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: "./agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves absolute path $include", () => {
    const absolute = etcClawdbotPath("agents.json");
    const files = { [absolute]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: absolute } };
    expect(resolve(obj, files)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
  });

  it("resolves array $include with deep merge", () => {
    const files = {
      [configPath("a.json")]: { "group-a": ["agent1"] },
      [configPath("b.json")]: { "group-b": ["agent2"] },
    };
    const obj = { broadcast: { $include: ["./a.json", "./b.json"] } };
    expect(resolve(obj, files)).toEqual({
      broadcast: {
        "group-a": ["agent1"],
        "group-b": ["agent2"],
      },
    });
  });

  it("deep merges overlapping keys in array $include", () => {
    const files = {
      [configPath("a.json")]: { agents: { defaults: { workspace: "~/a" } } },
      [configPath("b.json")]: { agents: { list: [{ id: "main" }] } },
    };
    const obj = { $include: ["./a.json", "./b.json"] };
    expect(resolve(obj, files)).toEqual({
      agents: {
        defaults: { workspace: "~/a" },
        list: [{ id: "main" }],
      },
    });
  });

  it("merges $include with sibling keys", () => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    const obj = { $include: "./base.json", c: 3 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("sibling keys override included values", () => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    const obj = { $include: "./base.json", b: 99 };
    expect(resolve(obj, files)).toEqual({ a: 1, b: 99 });
  });

  it("throws when sibling keys are used with non-object includes", () => {
    const files = { [configPath("list.json")]: ["a", "b"] };
    const obj = { $include: "./list.json", extra: true };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(
      /Sibling keys require included content to be an object/,
    );
  });

  it("throws when sibling keys are used with primitive includes", () => {
    const files = { [configPath("value.json")]: "hello" };
    const obj = { $include: "./value.json", extra: true };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(
      /Sibling keys require included content to be an object/,
    );
  });

  it("resolves nested includes", () => {
    const files = {
      [configPath("level1.json")]: { nested: { $include: "./level2.json" } },
      [configPath("level2.json")]: { deep: "value" },
    };
    const obj = { $include: "./level1.json" };
    expect(resolve(obj, files)).toEqual({
      nested: { deep: "value" },
    });
  });

  it("throws ConfigIncludeError for missing file", () => {
    const obj = { $include: "./missing.json" };
    expect(() => resolve(obj)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj)).toThrow(/Failed to read include file/);
  });

  it("throws ConfigIncludeError for invalid JSON", () => {
    const resolver: IncludeResolver = {
      readFile: () => "{ invalid json }",
      parseJson: JSON.parse,
    };
    const obj = { $include: "./bad.json" };
    expect(() =>
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver),
    ).toThrow(ConfigIncludeError);
    expect(() =>
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver),
    ).toThrow(/Failed to parse include file/);
  });

  it("throws CircularIncludeError for circular includes", () => {
    const aPath = configPath("a.json");
    const bPath = configPath("b.json");
    const resolver: IncludeResolver = {
      readFile: (filePath: string) => {
        if (filePath === aPath) {
          return JSON.stringify({ $include: "./b.json" });
        }
        if (filePath === bPath) {
          return JSON.stringify({ $include: "./a.json" });
        }
        throw new Error(`Unknown file: ${filePath}`);
      },
      parseJson: JSON.parse,
    };
    const obj = { $include: "./a.json" };
    try {
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver);
      throw new Error("expected circular include error");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularIncludeError);
      const circular = err as CircularIncludeError;
      expect(circular.chain).toEqual(
        expect.arrayContaining([DEFAULT_BASE_PATH, aPath, bPath]),
      );
      expect(circular.message).toMatch(/Circular include detected/);
      expect(circular.message).toContain("a.json");
      expect(circular.message).toContain("b.json");
    }
  });

  it("throws ConfigIncludeError for invalid $include value type", () => {
    const obj = { $include: 123 };
    expect(() => resolve(obj)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj)).toThrow(/expected string or array/);
  });

  it("throws ConfigIncludeError for invalid array item type", () => {
    const files = { [configPath("valid.json")]: { valid: true } };
    const obj = { $include: ["./valid.json", 123] };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/expected string, got number/);
  });

  it("throws ConfigIncludeError for null/boolean include items", () => {
    const files = { [configPath("valid.json")]: { valid: true } };
    const cases = [
      { value: null, expected: "object" },
      { value: false, expected: "boolean" },
    ];
    for (const item of cases) {
      const obj = { $include: ["./valid.json", item.value] };
      expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
      expect(() => resolve(obj, files)).toThrow(
        new RegExp(`expected string, got ${item.expected}`),
      );
    }
  });

  it("respects max depth limit", () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      files[configPath(`level${i}.json`)] = {
        $include: `./level${i + 1}.json`,
      };
    }
    files[configPath("level15.json")] = { done: true };

    const obj = { $include: "./level0.json" };
    expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    expect(() => resolve(obj, files)).toThrow(/Maximum include depth/);
  });

  it("allows depth 10 but rejects depth 11", () => {
    const okFiles: Record<string, unknown> = {};
    for (let i = 0; i < 9; i++) {
      okFiles[configPath(`ok${i}.json`)] = { $include: `./ok${i + 1}.json` };
    }
    okFiles[configPath("ok9.json")] = { done: true };
    expect(resolve({ $include: "./ok0.json" }, okFiles)).toEqual({
      done: true,
    });

    const failFiles: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      failFiles[configPath(`fail${i}.json`)] = {
        $include: `./fail${i + 1}.json`,
      };
    }
    failFiles[configPath("fail10.json")] = { done: true };
    expect(() => resolve({ $include: "./fail0.json" }, failFiles)).toThrow(
      ConfigIncludeError,
    );
    expect(() => resolve({ $include: "./fail0.json" }, failFiles)).toThrow(
      /Maximum include depth/,
    );
  });

  it("handles relative paths correctly", () => {
    const files = {
      [configPath("clients", "mueller", "agents.json")]: { id: "mueller" },
    };
    const obj = { agent: { $include: "./clients/mueller/agents.json" } };
    expect(resolve(obj, files)).toEqual({
      agent: { id: "mueller" },
    });
  });

  it("applies nested includes before sibling overrides", () => {
    const files = {
      [configPath("base.json")]: { nested: { $include: "./nested.json" } },
      [configPath("nested.json")]: { a: 1, b: 2 },
    };
    const obj = { $include: "./base.json", nested: { b: 9 } };
    expect(resolve(obj, files)).toEqual({
      nested: { a: 1, b: 9 },
    });
  });

  it("resolves parent directory references", () => {
    const files = { [sharedPath("common.json")]: { shared: true } };
    const obj = { $include: "../../shared/common.json" };
    expect(resolve(obj, files, configPath("sub", "clawdbot.json"))).toEqual({
      shared: true,
    });
  });
});

describe("real-world config patterns", () => {
  it("supports per-client agent includes", () => {
    const files = {
      [configPath("clients", "mueller.json")]: {
        agents: [
          {
            id: "mueller-screenshot",
            workspace: "~/clients/mueller/screenshot",
          },
          {
            id: "mueller-transcribe",
            workspace: "~/clients/mueller/transcribe",
          },
        ],
        broadcast: {
          "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
        },
      },
      [configPath("clients", "schmidt.json")]: {
        agents: [
          {
            id: "schmidt-screenshot",
            workspace: "~/clients/schmidt/screenshot",
          },
        ],
        broadcast: { "group-schmidt": ["schmidt-screenshot"] },
      },
    };

    const obj = {
      gateway: { port: 18789 },
      $include: ["./clients/mueller.json", "./clients/schmidt.json"],
    };

    expect(resolve(obj, files)).toEqual({
      gateway: { port: 18789 },
      agents: [
        { id: "mueller-screenshot", workspace: "~/clients/mueller/screenshot" },
        { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
        { id: "schmidt-screenshot", workspace: "~/clients/schmidt/screenshot" },
      ],
      broadcast: {
        "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
        "group-schmidt": ["schmidt-screenshot"],
      },
    });
  });

  it("supports modular config structure", () => {
    const files = {
      [configPath("gateway.json")]: {
        gateway: { port: 18789, bind: "loopback" },
      },
      [configPath("channels", "whatsapp.json")]: {
        channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
      },
      [configPath("agents", "defaults.json")]: {
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    };

    const obj = {
      $include: [
        "./gateway.json",
        "./channels/whatsapp.json",
        "./agents/defaults.json",
      ],
    };

    expect(resolve(obj, files)).toEqual({
      gateway: { port: 18789, bind: "loopback" },
      channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
  });
});
