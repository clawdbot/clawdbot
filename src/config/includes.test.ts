import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  CircularIncludeError,
  ConfigIncludeError,
  MAX_INCLUDE_FILE_BYTES,
  deepMerge,
  type IncludeResolver,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_OPENCLAW_DIR = path.join(ROOT_DIR, "etc", "openclaw");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcOpenClawPath(...parts: string[]) {
  return path.join(ETC_OPENCLAW_DIR, ...parts);
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

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

function expectResolveIncludeError(
  run: () => unknown,
  expectedPattern?: RegExp,
): ConfigIncludeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigIncludeError);
  if (expectedPattern) {
    expect((thrown as Error).message).toMatch(expectedPattern);
  }
  return thrown as ConfigIncludeError;
}

describe("resolveConfigIncludes", () => {
  it.each([
    { name: "string", value: "hello", expected: "hello" },
    { name: "number", value: 42, expected: 42 },
    { name: "boolean", value: true, expected: true },
    { name: "null", value: null, expected: null },
    { name: "array", value: [1, 2, { a: 1 }], expected: [1, 2, { a: 1 }] },
    {
      name: "nested object",
      value: { foo: "bar", nested: { x: 1 } },
      expected: { foo: "bar", nested: { x: 1 } },
    },
  ] as const)("passes through non-include $name values unchanged", ({ value, expected }) => {
    expect(resolve(value)).toEqual(expected);
  });

  it("rejects absolute path outside config directory (CWE-22)", () => {
    const absolute = etcOpenClawPath("agents.json");
    const files = { [absolute]: { list: [{ id: "main" }] } };
    const obj = { agents: { $include: absolute } };
    expectResolveIncludeError(() => resolve(obj, files), /escapes config directory/);
  });

  it.each([
    {
      name: "single file include",
      files: { [configPath("agents.json")]: { list: [{ id: "main" }] } },
      obj: { agents: { $include: "./agents.json" } },
      expected: {
        agents: { list: [{ id: "main" }] },
      },
    },
    {
      name: "array include deep merge",
      files: {
        [configPath("a.json")]: { "group-a": ["agent1"] },
        [configPath("b.json")]: { "group-b": ["agent2"] },
      },
      obj: { broadcast: { $include: ["./a.json", "./b.json"] } },
      expected: {
        broadcast: {
          "group-a": ["agent1"],
          "group-b": ["agent2"],
        },
      },
    },
    {
      name: "array include overlapping keys",
      files: {
        [configPath("a.json")]: { agents: { defaults: { workspace: "~/a" } } },
        [configPath("b.json")]: { agents: { list: [{ id: "main" }] } },
      },
      obj: { $include: ["./a.json", "./b.json"] },
      expected: {
        agents: {
          defaults: { workspace: "~/a" },
          list: [{ id: "main" }],
        },
      },
    },
  ] as const)("resolves include merges: $name", ({ obj, files, expected }) => {
    expect(resolve(obj, files)).toEqual(expected);
  });

  it.each([
    {
      name: "adds sibling keys after include",
      obj: { $include: "./base.json", c: 3 },
      expected: { a: 1, b: 2, c: 3 },
    },
    {
      name: "lets siblings override included keys",
      obj: { $include: "./base.json", b: 99 },
      expected: { a: 1, b: 99 },
    },
  ] as const)("merges include content with sibling keys: $name", ({ obj, expected }) => {
    const files = { [configPath("base.json")]: { a: 1, b: 2 } };
    expect(resolve(obj, files)).toEqual(expected);
  });

  it.each([
    { includeFile: "list.json", included: ["a", "b"] },
    { includeFile: "value.json", included: "hello" },
  ] as const)(
    "throws when sibling keys are used with non-object include $includeFile",
    ({ includeFile, included }) => {
      const files = { [configPath(includeFile)]: included };
      const obj = { $include: `./${includeFile}`, extra: true };
      expectResolveIncludeError(
        () => resolve(obj, files),
        /Sibling keys require included content to be an object/,
      );
    },
  );

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

  it.each([
    {
      name: "read failures",
      run: () => resolve({ $include: "./missing.json" }),
      pattern: /Failed to read include file/,
    },
    {
      name: "parse failures",
      run: () =>
        resolveConfigIncludes({ $include: "./bad.json" }, DEFAULT_BASE_PATH, {
          readFile: () => "{ invalid json }",
          parseJson: JSON.parse,
        }),
      pattern: /Failed to parse include file/,
    },
  ] as const)("surfaces include $name", ({ run, pattern }) => {
    expectResolveIncludeError(run, pattern);
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
      expect(circular.chain).toContain(DEFAULT_BASE_PATH);
      expect(circular.chain).toContain(aPath);
      expect(circular.chain).toContain(bPath);
      expect(circular.message).toMatch(/Circular include detected/);
      expect(circular.message).toContain("a.json");
      expect(circular.message).toContain("b.json");
    }
  });

  it.each([
    {
      name: "rejects scalar include value",
      obj: { $include: 123 },
      expectedPattern: /expected string or array/,
    },
    {
      name: "rejects number in include array",
      obj: { $include: ["./valid.json", 123] },
      expectedPattern: /expected string, got number/,
    },
    {
      name: "rejects null in include array",
      obj: { $include: ["./valid.json", null] },
      expectedPattern: /expected string, got object/,
    },
    {
      name: "rejects boolean in include array",
      obj: { $include: ["./valid.json", false] },
      expectedPattern: /expected string, got boolean/,
    },
  ] as const)("throws on invalid include value/item types: $name", ({ obj, expectedPattern }) => {
    const files = { [configPath("valid.json")]: { valid: true } };
    expectResolveIncludeError(() => resolve(obj, files), expectedPattern);
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
    expectResolveIncludeError(() => resolve(obj, files), /Maximum include depth/);
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
    expectResolveIncludeError(
      () => resolve({ $include: "./fail0.json" }, failFiles),
      /Maximum include depth/,
    );
  });

  it.each([
    {
      name: "resolves nested relative file path",
      files: {
        [configPath("clients", "mueller", "agents.json")]: { id: "mueller" },
      },
      obj: { agent: { $include: "./clients/mueller/agents.json" } },
      expected: {
        agent: { id: "mueller" },
      },
    },
    {
      name: "preserves nested override ordering",
      files: {
        [configPath("base.json")]: { nested: { $include: "./nested.json" } },
        [configPath("nested.json")]: { a: 1, b: 2 },
      },
      obj: { $include: "./base.json", nested: { b: 9 } },
      expected: {
        nested: { a: 1, b: 9 },
      },
    },
  ] as const)(
    "handles relative paths and nested include ordering: $name",
    ({ obj, files, expected }) => {
      expect(resolve(obj, files)).toEqual(expected);
    },
  );

  it("enforces traversal boundaries while allowing safe nested-parent paths", () => {
    expectResolveIncludeError(
      () =>
        resolve(
          { $include: "../../shared/common.json" },
          { [sharedPath("common.json")]: { shared: true } },
          configPath("sub", "openclaw.json"),
        ),
      /escapes config directory/,
    );

    expect(
      resolve(
        { $include: "./sub/child.json" },
        {
          [configPath("sub", "child.json")]: { $include: "../shared/common.json" },
          [configPath("shared", "common.json")]: { shared: true },
        },
      ),
    ).toEqual({
      shared: true,
    });
  });
});

describe("real-world config patterns", () => {
  it.each([
    {
      name: "per-client agent includes",
      files: {
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
      },
      obj: {
        gateway: { port: 18789 },
        $include: ["./clients/mueller.json", "./clients/schmidt.json"],
      },
      expected: {
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
      },
    },
    {
      name: "modular config structure",
      files: {
        [configPath("gateway.json")]: {
          gateway: { port: 18789, bind: "loopback" },
        },
        [configPath("channels", "whatsapp.json")]: {
          channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
        },
        [configPath("agents", "defaults.json")]: {
          agents: { defaults: { sandbox: { mode: "all" } } },
        },
      },
      obj: {
        $include: ["./gateway.json", "./channels/whatsapp.json", "./agents/defaults.json"],
      },
      expected: {
        gateway: { port: 18789, bind: "loopback" },
        channels: { whatsapp: { dmPolicy: "pairing", allowFrom: ["+49123"] } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    },
  ] as const)("supports common modular include layouts: $name", ({ obj, files, expected }) => {
    expect(resolve(obj, files)).toEqual(expected);
  });
});
describe("security: path traversal protection (CWE-22)", () => {
  function expectRejectedTraversalPaths(
    cases: ReadonlyArray<{ includePath: string; expectEscapesMessage: boolean }>,
  ) {
    for (const { includePath, expectEscapesMessage } of cases) {
      const obj = { $include: includePath };
      expect(() => resolve(obj, {}), includePath).toThrow(ConfigIncludeError);
      if (expectEscapesMessage) {
        expect(() => resolve(obj, {}), includePath).toThrow(/escapes config directory/);
      }
    }
  }

  describe("absolute path attacks", () => {
    it("rejects absolute path attack variants", () => {
      const cases = [
        { includePath: "/etc/passwd", expectEscapesMessage: true },
        { includePath: "/etc/shadow", expectEscapesMessage: true },
        { includePath: `${process.env.HOME}/.ssh/id_rsa`, expectEscapesMessage: false },
        { includePath: "/tmp/malicious.json", expectEscapesMessage: false },
        { includePath: "/", expectEscapesMessage: false },
      ] as const;
      expectRejectedTraversalPaths(cases);
    });
  });

  describe("relative traversal attacks", () => {
    it("rejects relative traversal path variants", () => {
      const cases = [
        { includePath: "../../etc/passwd", expectEscapesMessage: true },
        { includePath: "../../../etc/shadow", expectEscapesMessage: false },
        { includePath: "../../../../../../../../etc/passwd", expectEscapesMessage: false },
        { includePath: "../sibling-dir/secret.json", expectEscapesMessage: false },
        { includePath: "/config/../../../etc/passwd", expectEscapesMessage: false },
      ] as const;
      expectRejectedTraversalPaths(cases);
    });
  });

  describe("legitimate includes (should work)", () => {
    it.each([
      {
        name: "same-directory with ./ prefix",
        includePath: "./sub.json",
        files: { [configPath("sub.json")]: { key: "value" } },
        expected: { key: "value" },
      },
      {
        name: "same-directory without ./ prefix",
        includePath: "sub.json",
        files: { [configPath("sub.json")]: { key: "value" } },
        expected: { key: "value" },
      },
      {
        name: "subdirectory",
        includePath: "./sub/nested.json",
        files: { [configPath("sub", "nested.json")]: { nested: true } },
        expected: { nested: true },
      },
      {
        name: "deep subdirectory",
        includePath: "./a/b/c/deep.json",
        files: { [configPath("a", "b", "c", "deep.json")]: { deep: true } },
        expected: { deep: true },
      },
    ] as const)(
      "allows legitimate include path under config root: $name",
      ({ includePath, files, expected }) => {
        const obj = { $include: includePath };
        expect(resolve(obj, files)).toEqual(expected);
      },
    );

    // Note: Upward traversal from nested configs is restricted for security.
    // Each config file can only include files from its own directory and subdirectories.
    // This prevents potential path traversal attacks even in complex nested scenarios.
  });

  describe("error properties", () => {
    it.each([
      {
        includePath: "/etc/passwd",
        expectedMessageIncludes: ["escapes config directory", "/etc/passwd"],
      },
      {
        includePath: "/etc/shadow",
        expectedMessageIncludes: ["/etc/shadow"],
      },
      {
        includePath: "../../etc/passwd",
        expectedMessageIncludes: ["escapes config directory", "../../etc/passwd"],
      },
    ] as const)(
      "preserves error type/path/message details for $includePath",
      ({ includePath, expectedMessageIncludes }) => {
        const obj = { $include: includePath };
        try {
          resolve(obj, {});
          expect.fail("Should have thrown");
        } catch (err) {
          expect(err, includePath).toBeInstanceOf(ConfigIncludeError);
          expect(err, includePath).toHaveProperty("name", "ConfigIncludeError");
          expect((err as ConfigIncludeError).includePath, includePath).toBe(includePath);
          for (const messagePart of expectedMessageIncludes) {
            expect((err as Error).message, `${includePath}: ${messagePart}`).toContain(messagePart);
          }
        }
      },
    );
  });

  describe("array includes with malicious paths", () => {
    it.each([
      {
        name: "one malicious path",
        files: { [configPath("good.json")]: { good: true } },
        includePaths: ["./good.json", "/etc/passwd"],
      },
      {
        name: "multiple malicious paths",
        files: {},
        includePaths: ["/etc/passwd", "/etc/shadow"],
      },
    ] as const)("rejects arrays with malicious include paths: $name", ({ includePaths, files }) => {
      const obj = { $include: includePaths };
      expect(() => resolve(obj, files)).toThrow(ConfigIncludeError);
    });

    it("allows array with all legitimate paths", () => {
      const files = {
        [configPath("a.json")]: { a: 1 },
        [configPath("b.json")]: { b: 2 },
      };
      const obj = { $include: ["./a.json", "./b.json"] };
      expect(resolve(obj, files)).toEqual({ a: 1, b: 2 });
    });
  });

  describe("prototype pollution protection", () => {
    it("blocks prototype pollution vectors in shallow and nested merges", () => {
      const cases = [
        {
          base: {},
          incoming: JSON.parse('{"__proto__":{"polluted":true}}'),
          expected: {},
        },
        {
          base: { safe: 1 },
          incoming: { prototype: { x: 1 }, constructor: { y: 2 }, normal: 3 },
          expected: { safe: 1, normal: 3 },
        },
        {
          base: { nested: { a: 1 } },
          incoming: { nested: JSON.parse('{"__proto__":{"polluted":true}}') },
          expected: { nested: { a: 1 } },
        },
      ] as const;

      for (const { base, incoming, expected } of cases) {
        const result = deepMerge(base, incoming);
        expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
        expect(result).toEqual(expected);
      }
    });
  });

  describe("edge cases", () => {
    it.each([
      { includePath: "./file\x00.json", expectedError: undefined },
      { includePath: "//etc/passwd", expectedError: ConfigIncludeError },
    ] as const)("rejects malformed include path $includePath", ({ includePath, expectedError }) => {
      const obj = { $include: includePath };
      if (expectedError) {
        expectResolveIncludeError(() => resolve(obj, {}));
        return;
      }
      // Path with null byte should be rejected or handled safely.
      expectResolveIncludeError(() => resolve(obj, {}));
    });

    it("allows child include when config is at filesystem root", () => {
      const rootConfigPath = path.join(path.parse(process.cwd()).root, "test.json");
      const childPath = path.join(path.parse(process.cwd()).root, "child.json");
      const files = { [childPath]: { root: true } };
      const obj = { $include: childPath };
      expect(resolve(obj, files, rootConfigPath)).toEqual({ root: true });
    });

    it("allows include files when the config root path is a symlink", async () => {
      await withTempDir({ prefix: "openclaw-includes-symlink-" }, async (tempRoot) => {
        const realRoot = path.join(tempRoot, "real");
        const linkRoot = path.join(tempRoot, "link");
        await fs.mkdir(path.join(realRoot, "includes"), { recursive: true });
        await fs.writeFile(
          path.join(realRoot, "includes", "extra.json5"),
          "{ logging: { redactSensitive: 'tools' } }\n",
          "utf-8",
        );
        await fs.symlink(realRoot, linkRoot, process.platform === "win32" ? "junction" : undefined);

        const result = resolveConfigIncludes(
          { $include: "./includes/extra.json5" },
          path.join(linkRoot, "openclaw.json"),
        );
        expect(result).toEqual({ logging: { redactSensitive: "tools" } });
      });
    });

    it("fails closed when include realpath resolution fails for reasons other than ENOENT", () => {
      const includePath = configPath("denied.json");
      const originalRealpathSync = nodeFs.realpathSync;
      const realpathSpy = vi.spyOn(nodeFs, "realpathSync").mockImplementation((target) => {
        if (path.normalize(String(target)) === includePath) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalRealpathSync(target);
      });

      try {
        expectResolveIncludeError(
          () =>
            resolveConfigIncludes(
              { $include: "./denied.json" },
              DEFAULT_BASE_PATH,
              createMockResolver({ [includePath]: { leaked: true } }),
            ),
          /Failed to resolve include file realpath/,
        );
      } finally {
        realpathSpy.mockRestore();
      }
    });

    it("rejects include files that are hardlinked aliases", async () => {
      if (process.platform === "win32") {
        return;
      }
      await withTempDir({ prefix: "openclaw-includes-hardlink-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const outsideDir = path.join(tempRoot, "outside");
        await fs.mkdir(configDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        const includePath = path.join(configDir, "extra.json5");
        const outsidePath = path.join(outsideDir, "secret.json5");
        await fs.writeFile(outsidePath, '{"logging":{"redactSensitive":"tools"}}\n', "utf-8");
        try {
          await fs.link(outsidePath, includePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }

        expect(() =>
          resolveConfigIncludes(
            { $include: "./extra.json5" },
            path.join(configDir, "openclaw.json"),
          ),
        ).toThrow(/security checks|hardlink/i);
      });
    });

    it("rejects oversized include files", async () => {
      await withTempDir({ prefix: "openclaw-includes-big-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        await fs.mkdir(configDir, { recursive: true });
        const includePath = path.join(configDir, "big.json5");
        const payload = "a".repeat(MAX_INCLUDE_FILE_BYTES + 1);
        await fs.writeFile(includePath, `{"blob":"${payload}"}`, "utf-8");

        expect(() =>
          resolveConfigIncludes({ $include: "./big.json5" }, path.join(configDir, "openclaw.json")),
        ).toThrow(/security checks|max/i);
      });
    });
  });
});

describe("OPENCLAW_INCLUDE_ROOTS allowlist", () => {
  it("permits an include outside the config directory when its root is allowed", () => {
    const sharedFile = sharedPath("common.json");
    const files = { [sharedFile]: { shared: true } };
    expect(
      resolveConfigIncludes(
        { $include: sharedFile },
        DEFAULT_BASE_PATH,
        createMockResolver(files),
        { allowedRoots: [SHARED_DIR] },
      ),
    ).toEqual({ shared: true });
  });

  it("still rejects include paths that fall outside every allowed root", () => {
    const obj = { $include: etcOpenClawPath("agents.json") };
    expect(() =>
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, createMockResolver({}), {
        allowedRoots: [SHARED_DIR],
      }),
    ).toThrow(/escapes config directory/);
  });

  it.each([
    { name: "unset", allowedRoots: undefined },
    { name: "empty", allowedRoots: [] as string[] },
  ])(
    "preserves the original config-directory boundary when allowedRoots is $name",
    ({ allowedRoots }) => {
      const obj = { $include: sharedPath("common.json") };
      expect(() =>
        resolveConfigIncludes(obj, DEFAULT_BASE_PATH, createMockResolver({}), { allowedRoots }),
      ).toThrow(/escapes config directory/);
    },
  );

  it("ignores non-absolute or empty allowedRoots entries while honoring valid ones", () => {
    const sharedFile = sharedPath("common.json");
    const files = { [sharedFile]: { shared: true } };
    expect(
      resolveConfigIncludes(
        { $include: sharedFile },
        DEFAULT_BASE_PATH,
        createMockResolver(files),
        { allowedRoots: ["", "./relative", SHARED_DIR] },
      ),
    ).toEqual({ shared: true });
  });

  it("resolves a symlinked include whose realpath lands inside an allowed root", async () => {
    await withTempDir({ prefix: "openclaw-includes-allowed-symlink-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedDir = path.join(tempRoot, "shared");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(sharedDir, { recursive: true });
      const sharedTarget = path.join(sharedDir, "extra.json5");
      await fs.writeFile(sharedTarget, "{ logging: { redactSensitive: 'tools' } }\n", "utf-8");
      const linkInConfig = path.join(configDir, "extra.json5");
      await fs.symlink(
        sharedTarget,
        linkInConfig,
        process.platform === "win32" ? "file" : undefined,
      );

      const result = resolveConfigIncludes(
        { $include: "./extra.json5" },
        path.join(configDir, "openclaw.json"),
        undefined,
        { allowedRoots: [sharedDir] },
      );
      expect(result).toEqual({ logging: { redactSensitive: "tools" } });
    });
  });

  it("rejects a symlinked include that escapes both the config directory and every allowed root", async () => {
    await withTempDir({ prefix: "openclaw-includes-allowed-escape-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const allowedDir = path.join(tempRoot, "allowed");
      const offRootDir = path.join(tempRoot, "off-limits");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(offRootDir, { recursive: true });
      const offRootTarget = path.join(offRootDir, "secret.json5");
      await fs.writeFile(offRootTarget, "{ leaked: true }\n", "utf-8");
      const linkInConfig = path.join(configDir, "secret.json5");
      try {
        await fs.symlink(
          offRootTarget,
          linkInConfig,
          process.platform === "win32" ? "file" : undefined,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw err;
      }

      expect(() =>
        resolveConfigIncludes(
          { $include: "./secret.json5" },
          path.join(configDir, "openclaw.json"),
          undefined,
          { allowedRoots: [allowedDir] },
        ),
      ).toThrow(/resolves outside config directory/);
    });
  });
});
