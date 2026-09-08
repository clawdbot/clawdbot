import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findUndeclaredBundlerHelperDtsExports,
  sanitizeBundlerHelperDtsExports,
} from "../../scripts/lib/sanitize-bundler-helper-dts-exports.mts";

describe("sanitizeBundlerHelperDtsExports", () => {
  it("flags and removes an undeclared __exportAll named export", () => {
    const source = [
      "export declare const keepMe: number;",
      "export { keepMe as km, __exportAll as ud, alsoKeep as ak };",
      "export declare const alsoKeep: string;",
      "",
    ].join("\n");

    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([
      { name: "__exportAll", line: 2 },
    ]);

    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.removed).toEqual([{ name: "__exportAll", line: 2 }]);
    expect(sanitized.sourceText).toContain("keepMe as km");
    expect(sanitized.sourceText).toContain("alsoKeep as ak");
    expect(sanitized.sourceText).not.toContain("__exportAll");
    expect(findUndeclaredBundlerHelperDtsExports(sanitized.sourceText)).toEqual([]);
  });

  it("keeps __exportAll when the declaration file declares it", () => {
    const source = [
      "declare function __exportAll(target: object, all: object): void;",
      "export { __exportAll as ud };",
      "",
    ].join("\n");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([]);
    expect(sanitizeBundlerHelperDtsExports(source).sourceText).toBe(source);
  });

  it("keeps a directly imported __exportAll binding", () => {
    const source = [
      'import { __exportAll } from "./helper.js";',
      "export { __exportAll as ud };",
      "",
    ].join("\n");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([]);
    expect(sanitizeBundlerHelperDtsExports(source).sourceText).toBe(source);
  });

  it("removes generated helper aliases from mixed imports", () => {
    const source = [
      'import { keep as k, ud as __exportAll } from "./helper.js";',
      "export { keep as k };",
      "",
    ].join("\n");
    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.sourceText).toContain('import { keep as k } from "./helper.js";');
    expect(sanitized.sourceText).not.toContain("__exportAll");

    const onlyHelper = sanitizeBundlerHelperDtsExports(
      'import { ud as __exportAll } from "./helper.js";\nexport {};\n',
    );
    expect(onlyHelper.sourceText).not.toContain("__exportAll");
  });

  it("clears the published 2026.8.2 undeclared __exportAll export shape", () => {
    const source = readFileSync(
      new URL("../fixtures/published-2026.8.2-undeclared-exportall.d.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("__exportAll as ud");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([
      { name: "__exportAll", line: 5 },
    ]);
    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.removed).toEqual([{ name: "__exportAll", line: 5 }]);
    expect(sanitized.sourceText).toContain("SessionDiscussionProvider as uc");
    expect(sanitized.sourceText).toContain("DispatchReplyWithDispatcher as ui");
    expect(sanitized.sourceText).not.toContain("__exportAll");
    expect(findUndeclaredBundlerHelperDtsExports(sanitized.sourceText)).toEqual([]);
  });
});
