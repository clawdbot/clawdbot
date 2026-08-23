// Script erasability tests cover Node's transformation-free TypeScript boundary.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkScriptErasability } from "../../scripts/check-script-erasability.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

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

    expect(checkScriptErasability(scriptsRoot)).toEqual({ checkedFiles: 2, errors: [] });
  });

  it("rejects transform-required syntax in deterministic file order", () => {
    const scriptsRoot = writeScriptsTree({
      "z-parameter-property.ts": "class Client { constructor(private token: string) {} }",
      "a-runtime-enum.cts": "enum State { Ready }",
    });

    const result = checkScriptErasability(scriptsRoot);

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
    const result = checkScriptErasability(scriptsRoot);

    expect(result.checkedFiles).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});
