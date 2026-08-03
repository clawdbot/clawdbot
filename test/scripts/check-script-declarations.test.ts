import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyScriptDeclarationContracts } from "../../scripts/check-script-declarations.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("script declaration contracts", () => {
  it("fails deliberate export drift and passes after regenerating the declaration", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "example.mjs"),
      "export function stable() {}\nexport function added() {}\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "example.d.mts"),
      "export function stable(): void;\n",
    );
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { added } from "../scripts/example.mjs";\nvoid added;\n',
    );
    const files = ["scripts/example.d.mts", "scripts/example.mjs", "test/consumer.ts"];

    expect(verifyScriptDeclarationContracts({ root, files })).toEqual({
      checked: 1,
      issues: ["scripts/example.d.mts: value-export contract drift; missing added"],
    });

    fs.writeFileSync(
      path.join(root, "scripts", "example.d.mts"),
      "export function added(): void;\nexport function stable(): void;\n",
    );

    expect(verifyScriptDeclarationContracts({ root, files })).toEqual({ checked: 1, issues: [] });
  });

  it("requires declarations for scripts imported by typed sources", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "missing.mjs"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { value } from "../scripts/missing.mjs";\nvoid value;\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/missing.mjs", "test/consumer.ts"],
      }),
    ).toEqual({
      checked: 0,
      issues: ["scripts/missing.mjs: missing scripts/missing.d.mts"],
    });
  });

  it("rejects declaration sidecars whose runtime script is missing", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "orphan.d.mts"), "export const value: 1;\n");
    fs.writeFileSync(
      path.join(root, "test", "consumer.ts"),
      'import { value } from "../scripts/orphan.mjs";\nvoid value;\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/orphan.d.mts", "test/consumer.ts"],
      }),
    ).toEqual({
      checked: 0,
      issues: ["scripts/orphan.mjs: missing runtime source"],
    });
  });

  it("ignores tracked declaration pairs deleted from the working tree", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const runtimePath = path.join(root, "scripts", "removed.mjs");
    const declarationPath = path.join(root, "scripts", "removed.d.mts");
    fs.writeFileSync(runtimePath, "export const value = 1;\n");
    fs.writeFileSync(declarationPath, "export const value: 1;\n");
    execFileSync("git", ["add", "scripts/removed.mjs", "scripts/removed.d.mts"], { cwd: root });
    fs.rmSync(runtimePath);
    fs.rmSync(declarationPath);

    expect(verifyScriptDeclarationContracts({ root })).toEqual({ checked: 0, issues: [] });
  });

  it("applies ESM default and ambiguity rules to star re-exports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "left.mjs"),
      "export default 1;\nexport const shared = 1;\nexport const left = 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "right.mjs"),
      "export const shared = 2;\nexport const right = 1;\n",
    );
    fs.writeFileSync(path.join(root, "scripts", "left-alias.mjs"), 'export * from "./left.mjs";\n');
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "./left.mjs";\nexport * from "./left-alias.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.d.mts"),
      "export const left: 1;\nexport const right: 1;\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/left-alias.mjs",
          "scripts/left.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("propagates ambiguity through nested star re-exports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "left.mjs"), "export const shared = 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "right.mjs"), "export const shared = 2;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "inner.mjs"),
      'export * from "./left.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "outer.mjs"),
      'export * from "./inner.mjs";\nexport * from "./left.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "outer.d.mts"), "export {};\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/inner.mjs",
          "scripts/left.mjs",
          "scripts/outer.d.mts",
          "scripts/outer.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("fails closed on cyclic star graphs", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "a.mjs"), 'export * from "./b.mjs";\n');
    fs.writeFileSync(
      path.join(root, "scripts", "b.mjs"),
      'export const value = 1;\nexport * from "./a.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "a.d.mts"), "export const value: 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "b.d.mts"), "export const value: 1;\n");

    const result = verifyScriptDeclarationContracts({
      root,
      files: ["scripts/a.d.mts", "scripts/a.mjs", "scripts/b.d.mts", "scripts/b.mjs"],
    });
    expect(result.checked).toBe(2);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.includes("cyclic star re-export"))).toBe(true);
  });

  it("fails closed on explicit re-exports of ambiguous bindings", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "left.mjs"), "export const shared = 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "right.mjs"), "export const shared = 2;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "inner.mjs"),
      'export * from "./left.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export { shared } from "./inner.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export {};\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/inner.mjs",
          "scripts/left.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/barrel.mjs: ambiguous named re-export "./inner.mjs:shared"'],
    });
  });

  it("fails closed when a star re-export cannot be resolved", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "barrel.mjs"), 'export * from "package";\n');
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export {};\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/barrel.d.mts", "scripts/barrel.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/barrel.mjs: unresolved star re-export "package"'],
    });
  });

  it("resolves declaration stars to declarations before runtime modules", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib", "helper.mjs"),
      "export const one = 1;\nexport const two = 2;\n",
    );
    fs.writeFileSync(path.join(root, "lib", "helper.d.mts"), "export const one: 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "../lib/helper.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.d.mts"),
      'export * from "../lib/helper.mjs";\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["lib/helper.d.mts", "lib/helper.mjs", "scripts/barrel.d.mts", "scripts/barrel.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ["scripts/barrel.d.mts: value-export contract drift; missing two"],
    });
  });

  it("does not count type-only named or default declaration exports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "types.mjs"),
      "export const Foo = 1;\nexport default 1;\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "types.d.mts"),
      "interface Foo {}\nexport { Foo };\nexport default interface Default {}\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/types.d.mts", "scripts/types.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ["scripts/types.d.mts: value-export contract drift; missing default, Foo"],
    });
  });

  it("preserves local binding identity through renamed star paths", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "origin.mjs"),
      "const value = 1;\nexport { value as left, value as right };\n",
    );
    fs.writeFileSync(
      path.join(root, "scripts", "left.mjs"),
      'export { left as shared } from "./origin.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "right.mjs"),
      'export { right as shared } from "./origin.mjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "./left.mjs";\nexport * from "./right.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export const shared: 1;\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/left.mjs",
          "scripts/origin.mjs",
          "scripts/right.mjs",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("preserves statically named exports from external modules", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "external.mjs"),
      'import { readFile } from "fs/promises";\nexport { readFile };\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "external.d.mts"),
      "export declare const readFile: unknown;\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/external.d.mts", "scripts/external.mjs"],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("fails closed on external declaration re-exports with unknown value provenance", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "external.mjs"), "export const Foo = 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "external.d.mts"),
      'export { Foo } from "types-only-package";\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/external.d.mts", "scripts/external.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: [
        'scripts/external.d.mts: unresolved external declaration re-export "types-only-package"',
      ],
    });
  });

  it("fails closed on re-exported external declaration imports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "external.mjs"), "export const Foo = 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "external.d.mts"),
      'import { Foo } from "types-only-package";\nexport { Foo };\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/external.d.mts", "scripts/external.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: [
        'scripts/external.d.mts: unresolved external declaration import "types-only-package"',
      ],
    });
  });

  it("accepts statically value-bearing external namespace declaration imports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "external.mjs"),
      'import * as pkg from "pkg";\nexport { pkg };\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "external.d.mts"),
      'import * as pkg from "pkg";\nexport { pkg };\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/external.d.mts", "scripts/external.mjs"],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("retains runtime exports imported from opaque local modules", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "config.json"), '{"enabled":true}\n');
    fs.writeFileSync(
      path.join(root, "scripts", "config.mjs"),
      'import config from "./config.json" with { type: "json" };\nexport { config };\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "config.d.mts"),
      "export declare const config: { enabled: boolean };\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/config.d.mts", "scripts/config.json", "scripts/config.mjs"],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("fails closed on missing exports from analyzable local modules", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "origin.mjs"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'import { typo } from "./origin.mjs";\nexport { typo };\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export const typo: 1;\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/barrel.d.mts", "scripts/barrel.mjs", "scripts/origin.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/barrel.mjs: unresolved imported value "./origin.mjs:typo"'],
    });
  });

  it("fails closed on named JSON imports", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "config.json"), '{"enabled":true}\n');
    fs.writeFileSync(
      path.join(root, "scripts", "config.mjs"),
      'import { enabled } from "./config.json" with { type: "json" };\nexport { enabled };\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "config.d.mts"),
      "export declare const enabled: boolean;\n",
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: ["scripts/config.d.mts", "scripts/config.json", "scripts/config.mjs"],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/config.mjs: unresolved imported value "./config.json:enabled"'],
    });
  });

  it("resolves CommonJS imports to adjacent declaration sidecars", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "helper.cjs"), "exports.value = 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "helper.d.cts"), "export const value: 1;\n");
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export { value } from "./helper.cjs";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.d.mts"),
      'export { value } from "./helper.cjs";\n',
    );

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/helper.cjs",
          "scripts/helper.d.cts",
        ],
      }),
    ).toEqual({ checked: 1, issues: [] });
  });

  it("distinguishes namespace objects from named external bindings", () => {
    const root = tempDirs.make("openclaw-script-declarations-");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts", "namespace.mjs"),
      'export * as shared from "pkg";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "named.mjs"),
      'export { namespace as shared } from "pkg";\n',
    );
    fs.writeFileSync(
      path.join(root, "scripts", "barrel.mjs"),
      'export * from "./namespace.mjs";\nexport * from "./named.mjs";\n',
    );
    fs.writeFileSync(path.join(root, "scripts", "barrel.d.mts"), "export {};\n");

    expect(
      verifyScriptDeclarationContracts({
        root,
        files: [
          "scripts/barrel.d.mts",
          "scripts/barrel.mjs",
          "scripts/named.mjs",
          "scripts/namespace.mjs",
        ],
      }),
    ).toEqual({
      checked: 1,
      issues: ['scripts/barrel.mjs: opaque external star collision "shared"'],
    });
  });
});
