import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSparseTsgoSkipEnv,
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "../../scripts/lib/tsgo-sparse-guard.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("run-tsgo sparse guard", () => {
  it("ignores non-core projects", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.extensions.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores full worktrees", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => false,
      }),
    ).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json", "--showConfig"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores sparse worktrees when the required files are present", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/ui/app-settings.ts",
      "ui/src/ui/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      const dir = path.dirname(absolutePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.non-agents.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: ["/packages/", "/ui/src/"],
      }),
    ).toBeNull();
  });

  it("rejects sparse core worktrees that include only selected ui and package files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const requiredPaths = [
      "packages/plugin-package-contract/src/index.ts",
      "ui/src/i18n/lib/registry.ts",
      "ui/src/i18n/lib/types.ts",
      "ui/src/ui/app-settings.ts",
      "ui/src/ui/gateway.ts",
    ];

    for (const relativePath of requiredPaths) {
      const absolutePath = path.join(cwd, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "", "utf8");
    }

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
        sparseCheckoutPatterns: [
          "/packages/plugin-package-contract/src/index.ts",
          "/ui/src/i18n/lib/registry.ts",
          "/ui/src/i18n/lib/types.ts",
          "/ui/src/ui/app-settings.ts",
          "/ui/src/ui/gateway.ts",
        ],
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages
      - ui/src
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse core worktrees missing transitive project files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");
    const uiToolDisplay = path.join(cwd, "ui/src/ui/tool-display.ts");
    fs.mkdirSync(path.dirname(uiToolDisplay), { recursive: true });
    fs.writeFileSync(uiToolDisplay, "", "utf8");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "test/tsconfig/tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json cannot be typechecked from this sparse checkout because tracked project inputs are missing or only partially included:
      - packages/plugin-package-contract/src/index.ts
      - ui/src/i18n/lib/registry.ts
      - ui/src/i18n/lib/types.ts
      - ui/src/ui/app-settings.ts
      - ui/src/ui/gateway.ts
      Expand this worktree's sparse checkout to include those paths, or rerun in a full worktree."
    `);
  });

  it("recognizes the check:changed sparse-skip env", () => {
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "1" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "true" })).toBe(true);
    expect(shouldSkipSparseTsgoGuardError({ OPENCLAW_TSGO_SPARSE_SKIP: "0" })).toBe(false);
    expect(createSparseTsgoSkipEnv({ PATH: "/usr/bin" })).toStrictEqual({
      PATH: "/usr/bin",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
  });
});
