// Script erasability tests cover Node's transformation-free TypeScript boundary.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { checkScriptErasability } from "../../scripts/check-script-erasability.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function checkNodeScriptErasability(root: string): ReturnType<typeof checkScriptErasability> {
  // Only Node's strip-only parser can prove this contract, even with a Bun test runner.
  const checkerUrl = new URL("../../scripts/check-script-erasability.mjs", import.meta.url).href;
  const output = execFileSync(
    requireNodeTool("node"),
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      `import { checkScriptErasability } from ${JSON.stringify(checkerUrl)};
       console.log(JSON.stringify(checkScriptErasability(process.argv[1])));`,
      root,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function writeScriptsTree(files: Record<string, string>): string {
  const scriptsRoot = path.join(createTempDir("openclaw-script-erasability-"), "scripts");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(scriptsRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return scriptsRoot;
}

describe("check-script-erasability", () => {
  it("accepts erasable annotations and enum-like string content", () => {
    const scriptsRoot = writeScriptsTree({
      "annotations.ts": `
        interface User { name: string }
        const user: User = { name: "Ada" };
        export function nameOf(value: User): string { return value.name; }
      `,
      "generated-text.mts": `
        export const swift = \`enum GatewayEvent { case ready }\`;
        export const kotlin: string = "enum class GatewayEvent { Ready }";
      `,
      "types.d.ts": "declare enum RuntimeShape { Ready }",
      "build/output.ts": "enum BuiltOutput { Ready }",
      "dist/output.ts": "enum DistOutput { Ready }",
      "generated/output.ts": "enum GeneratedOutput { Ready }",
      "node_modules/example/index.ts": "enum DependencyOutput { Ready }",
    });

    expect(checkNodeScriptErasability(scriptsRoot)).toEqual({ checkedFiles: 2, errors: [] });
  });

  it("rejects transform-required syntax in deterministic file order", () => {
    const scriptsRoot = writeScriptsTree({
      "z-parameter-property.ts": "class Client { constructor(private token: string) {} }",
      "a-runtime-enum.cts": "enum State { Ready }",
    });

    const result = checkNodeScriptErasability(scriptsRoot);

    expect(result.checkedFiles).toBe(2);
    expect(result.errors.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "scripts/a-runtime-enum.cts", line: 1 },
      { file: "scripts/z-parameter-property.ts", line: 1 },
    ]);
    expect(result.errors[0]?.message).toMatch(/enum.*strip-only/u);
    expect(result.errors[1]?.message).toMatch(/parameter property.*strip-only/u);
  });

  it("accepts the repository scripts tree", () => {
    const scriptsRoot = path.resolve(import.meta.dirname, "../../scripts");
    const result = checkNodeScriptErasability(scriptsRoot);

    expect(result.checkedFiles).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});
