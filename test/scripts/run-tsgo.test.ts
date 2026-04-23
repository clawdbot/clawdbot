import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSparseTsgoGuardError } from "../../scripts/lib/tsgo-sparse-guard.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("run-tsgo sparse guard", () => {
  it("ignores non-core-test projects", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("ignores full worktrees", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => false,
      }),
    ).toBeNull();
  });

  it("ignores metadata-only commands", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.test.json", "--showConfig"], {
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
      getSparseTsgoGuardError(["-p", "tsconfig.core.test.non-agents.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toBeNull();
  });

  it("returns a helpful message for sparse core-test worktrees missing ui and packages files", () => {
    const cwd = createTempDir("openclaw-run-tsgo-");

    expect(
      getSparseTsgoGuardError(["-p", "tsconfig.core.test.json"], {
        cwd,
        isSparseCheckoutEnabled: () => true,
      }),
    ).toMatchInlineSnapshot(`
      "tsconfig.core.test.json requires a full worktree, but this checkout is sparse and missing files that the core test graph imports:
      - packages/plugin-package-contract/src/index.ts
      - ui/src/i18n/lib/registry.ts
      - ui/src/i18n/lib/types.ts
      - ui/src/ui/app-settings.ts
      - ui/src/ui/gateway.ts
      Run "gwt sparse full" in this worktree, then rerun the tsgo command."
    `);
  });
});
