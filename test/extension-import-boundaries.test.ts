// Extension import boundary tests enforce extension/core import rules.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtensionPluginSdkBoundaryChecker,
  main as extensionPluginSdkMain,
} from "../scripts/check-extension-plugin-sdk-boundary.mts";
import { main as sdkPackageMain } from "../scripts/check-sdk-package-extension-import-boundary.mts";
import { main as srcExtensionMain } from "../scripts/check-src-extension-import-boundary.mts";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type CapturedIo = ReturnType<typeof createCapturedIo>["io"];
type JsonOutputPromise = ReturnType<typeof getJsonOutput>;

const boundaryInventoryCases: Array<{
  name: string;
  output: JsonOutputPromise;
}> = [
  {
    name: "src extension import boundary",
    output: getJsonOutput(srcExtensionMain, ["--json"]),
  },
  {
    name: "sdk/package extension import boundary",
    output: getJsonOutput(sdkPackageMain, ["--json"]),
  },
  {
    name: "extension src outside plugin-sdk boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=src-outside-plugin-sdk", "--json"]),
  },
  {
    name: "extension plugin-sdk-internal boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=plugin-sdk-internal", "--json"]),
  },
  {
    name: "extension relative-outside-package boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=relative-outside-package", "--json"]),
  },
  {
    name: "extension normalization-core bypass boundary",
    output: getJsonOutput(extensionPluginSdkMain, ["--mode=normalization-core-bypass", "--json"]),
  },
];

describe("fast module reference scanner", () => {
  it("collects code references without matching comments or strings", () => {
    expect(
      collectModuleReferencesFromSource(`
// import "./commented";
const text = 'import("./string")';
import "./side-effect";
import type { Example } from "./types";
export { Example } from "./public";
await import("./runtime");
`),
    ).toEqual([
      { kind: "import", line: 4, specifier: "./side-effect" },
      { kind: "import", line: 5, specifier: "./types" },
      { kind: "export", line: 6, specifier: "./public" },
      { kind: "dynamic-import", line: 7, specifier: "./runtime" },
    ]);
  });
});

describe("extension import boundary inventories", () => {
  it.each(boundaryInventoryCases)("$name JSON output stays empty", async ({ output }) => {
    const jsonOutput = await output;

    expect(jsonOutput.exitCode).toBe(0);
    expect(jsonOutput.stderr).toBe("");
    expect(jsonOutput.json).toStrictEqual([]);
  });
});

type BoundaryFixture = {
  file?: string;
  packageJson?: unknown;
  source: string;
};

function createBoundaryFixture(fixture: BoundaryFixture) {
  const repoRoot = tempDirs.make("openclaw-normalization-boundary-");
  const pluginRoot = path.join(repoRoot, "extensions", "demo");
  const relativeFile = fixture.file ?? "src/runtime.ts";
  const filePath = path.join(pluginRoot, relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fixture.source, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify(fixture.packageJson ?? { name: "@openclaw/demo" }),
    "utf8",
  );
  return createExtensionPluginSdkBoundaryChecker({ repoRoot });
}

describe("production plugin normalization ownership boundary", () => {
  it.each([
    {
      name: "static string import",
      source:
        'import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";',
      kind: "import",
      specifier: "@openclaw/normalization-core/string-coerce",
      resolvedPath: "packages/normalization-core/src/string-coerce.ts",
      facade: "openclaw/plugin-sdk/string-coerce-runtime",
    },
    {
      name: "record re-export from public barrel",
      file: "api.ts",
      source: 'export { isRecord } from "@openclaw/normalization-core/record-coerce";',
      kind: "export",
      specifier: "@openclaw/normalization-core/record-coerce",
      resolvedPath: "packages/normalization-core/src/record-coerce.ts",
      facade: "openclaw/plugin-sdk/string-coerce-runtime",
    },
    {
      name: "dynamic number import",
      source: 'await import("@openclaw/normalization-core/number-coercion");',
      kind: "dynamic-import",
      specifier: "@openclaw/normalization-core/number-coercion",
      resolvedPath: "packages/normalization-core/src/number-coercion.ts",
      facade: "openclaw/plugin-sdk/number-runtime",
    },
    {
      name: "error import",
      source: 'import { toErrorObject } from "@openclaw/normalization-core/error-coercion";',
      kind: "import",
      specifier: "@openclaw/normalization-core/error-coercion",
      resolvedPath: "packages/normalization-core/src/error-coercion.ts",
      facade: "openclaw/plugin-sdk/error-runtime",
    },
    {
      name: "bare package import",
      source: 'import { expectDefined } from "@openclaw/normalization-core";',
      kind: "import",
      specifier: "@openclaw/normalization-core",
      resolvedPath: "packages/normalization-core/src/index.ts",
    },
    {
      name: "relative normalization-core escape",
      source:
        'import { isRecord } from "../../../packages/normalization-core/src/record-coerce.js";',
      kind: "import",
      specifier: "../../../packages/normalization-core/src/record-coerce.js",
      resolvedPath: "packages/normalization-core/src/record-coerce.js",
      facade: "openclaw/plugin-sdk/string-coerce-runtime",
    },
    {
      name: "relative boolean owner escape",
      source: 'import { parseBooleanValue } from "../../../src/utils/boolean.js";',
      kind: "import",
      specifier: "../../../src/utils/boolean.js",
      resolvedPath: "src/utils/boolean.js",
      facade: "openclaw/plugin-sdk/string-coerce-runtime",
    },
    {
      name: "relative core error owner escape",
      source: 'import { formatErrorMessage } from "../../../src/infra/errors.js";',
      kind: "import",
      specifier: "../../../src/infra/errors.js",
      resolvedPath: "src/infra/errors.js",
      facade: "openclaw/plugin-sdk/error-runtime",
    },
  ])(
    "rejects $name with a specific public facade when known",
    async ({ source, file, kind, specifier, resolvedPath, facade }) => {
      const checker = createBoundaryFixture({ source, file });
      const captured = createCapturedIo();
      const exitCode = await checker.main(
        ["--mode=normalization-core-bypass", "--json"],
        captured.io,
      );
      const entries = JSON.parse(captured.readStdout()) as Array<Record<string, unknown>>;

      expect(exitCode).toBe(1);
      expect(captured.readStderr()).toBe("");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        file: `extensions/demo/${file ?? "src/runtime.ts"}`,
        line: 1,
        kind,
        specifier,
        resolvedPath,
      });
      expect(entries[0]?.reason).toContain(facade ?? "matching public openclaw/plugin-sdk facade");
    },
  );

  it.each([
    {
      name: "approved SDK facades",
      source: [
        'import "openclaw/plugin-sdk/string-coerce-runtime";',
        'import "openclaw/plugin-sdk/number-runtime";',
        'import "openclaw/plugin-sdk/error-runtime";',
      ].join("\n"),
    },
    { name: "plugin-local import", source: 'import "./local.js";' },
    {
      name: "test source",
      file: "src/runtime.test.ts",
      source: 'import "@openclaw/normalization-core/record-coerce";',
    },
    {
      name: "dist generated source",
      file: "dist/generated.js",
      source: 'import "@openclaw/normalization-core/record-coerce";',
    },
    {
      name: "declared generated asset",
      file: "src/generated.js",
      packageJson: {
        name: "@openclaw/demo",
        openclaw: {
          assetScripts: { build: "node build.mjs" },
          build: { staticAssets: [{ source: "src/generated.js", output: "generated.js" }] },
        },
      },
      source: 'import "@openclaw/normalization-core/record-coerce";',
    },
    {
      name: "comments and string literals",
      source: [
        '// import "@openclaw/normalization-core/record-coerce";',
        'const text = "import(\\\"@openclaw/normalization-core/error-coercion\\\")";',
      ].join("\n"),
    },
    {
      name: "serialized local guard",
      source: [
        "function isRecord(value: unknown) {",
        '  return value !== null && typeof value === "object" && !Array.isArray(value);',
        "}",
        "export const serialized = isRecord.toString();",
      ].join("\n"),
    },
  ])("allows $name", async ({ source, file, packageJson }) => {
    const checker = createBoundaryFixture({ source, file, packageJson });
    const captured = createCapturedIo();

    expect(await checker.main(["--mode=normalization-core-bypass", "--json"], captured.io)).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });

  it("renders actionable human diagnostics and fails strict mode", async () => {
    const checker = createBoundaryFixture({
      source: 'export { toErrorObject } from "@openclaw/normalization-core/error-coercion";',
      file: "runtime-api.ts",
    });
    const captured = createCapturedIo();

    expect(await checker.main(["--mode=normalization-core-bypass"], captured.io)).toBe(1);
    expect(captured.readStdout()).toContain(
      "Rule: production bundled plugins must not import normalization-core directly",
    );
    expect(captured.readStdout()).toContain("extensions/demo/runtime-api.ts");
    expect(captured.readStdout()).toContain("line 1 [export]");
    expect(captured.readStdout()).toContain("re-exports");
    expect(captured.readStdout()).toContain("@openclaw/normalization-core/error-coercion");
    expect(captured.readStdout()).toContain("openclaw/plugin-sdk/error-runtime");
    expect(captured.readStderr()).toContain("this strict mode has no baseline");
  });
});

async function getJsonOutput(
  main: (argv: string[], io: CapturedIo) => Promise<number>,
  argv: string[],
) {
  const captured = createCapturedIo();
  const exitCode = await main(argv, captured.io);
  return {
    exitCode,
    stderr: captured.readStderr(),
    json: JSON.parse(captured.readStdout()),
  };
}
