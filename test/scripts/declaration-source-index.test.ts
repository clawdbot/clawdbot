import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverDeclarationSources } from "../../scripts/lib/declaration-source-index.mts";

describe("declaration source discovery", () => {
  let root: string;
  let tsconfig: string;

  function write(relativePath: string, contents: string) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "declaration-source-index-")));
    write("package.json", '{"type":"module"}');
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    tsconfig = write(
      "tsconfig.plugin-sdk.dts.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: [],
          declaration: true,
          emitDeclarationOnly: true,
          paths: { "@fixture/*": ["./contracts/*.ts"] },
        },
        include: ["entries/**/*.ts"],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("emits aliases and transitive type-only sources outside the selected entry roots", async () => {
    const entry = write(
      "entries/sdk.ts",
      'export { createValue } from "../runtime.js"; export type { Contract } from "@fixture/types";',
    );
    const runtime = write(
      "runtime.ts",
      'import type { Contract } from "@fixture/types"; export function createValue(label: string): Contract { return { label }; }',
    );
    const contract = write("contracts/types.ts", "export type Contract = { label: string };");
    write("entries/unselected.ts", "export type Unselected = never;");

    const files = discoverDeclarationSources(tsconfig, [entry]);
    expect(files).toEqual([entry, runtime, contract].toSorted());
    const outDir = path.join(root, "output");
    await build({
      config: false,
      entry: { sdk: entry },
      tsconfig,
      dts: { emitDtsOnly: true, eager: true, tsconfigRaw: { files, include: [] } },
      outDir,
      outExtensions: () => ({ dts: ".d.ts" }),
      format: "esm",
      logLevel: "error",
      report: false,
    });
    const declaration = fs.readFileSync(path.join(outDir, "sdk.d.ts"), "utf8");
    expect(declaration).toContain("label: string");
    expect(declaration).toContain("createValue");
    expect(declaration).toContain("Contract");
    expect(fs.readdirSync(outDir).every((file) => file.endsWith(".d.ts"))).toBe(true);
  });

  it("rediscovers fresh membership deterministically without an inventory or include glob", () => {
    const entry = write("entries/sdk.ts", 'export type { Value } from "../first.js";');
    const first = write("first.ts", "export type Value = string;");
    write("entries/unselected.ts", "export type Unselected = never;");
    expect(discoverDeclarationSources(tsconfig, [entry])).toEqual([entry, first].toSorted());

    const second = write("second.ts", "export type Value = number;");
    write("entries/sdk.ts", 'export type { Value } from "../second.js";');
    expect(discoverDeclarationSources(tsconfig, [entry])).toEqual([entry, second].toSorted());
  });

  it.each(["missing entry", "invalid config"])(
    "propagates %s from discovery before replacing declarations or stamping success",
    (failure) => {
      const declaration = write("dist/plugin-sdk/previous.d.ts", "previous declaration");
      const stamp = write("dist/plugin-sdk/.boundary-entry-shims.stamp", "previous stamp");
      if (failure === "invalid config") {
        write("tsconfig.plugin-sdk.dts.json", '{"compilerOptions":{"unknownOption":true}}');
      }
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", path.resolve("scripts/write-plugin-sdk-entry-dts.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_PLUGIN_SDK_CANONICAL_DTS: "0" },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("[declaration-source-index] FAILED (exit 1)");
      expect(fs.readFileSync(declaration, "utf8")).toBe("previous declaration");
      expect(fs.readFileSync(stamp, "utf8")).toBe("previous stamp");
      expect(fs.existsSync(path.join(root, "packages/plugin-sdk/dist"))).toBe(false);
    },
  );
});
