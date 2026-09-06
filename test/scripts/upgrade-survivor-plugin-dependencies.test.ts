import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runDependencyFixture(
  requested: string,
  packagedDir?: string,
  mutation?: "remove-shared" | "keep-package",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-upgrade-dependencies-")));
  const prefix = join(root, "prefix");
  if (packagedDir) {
    mkdirSync(join(prefix, "lib/node_modules/openclaw", packagedDir, "discord"), {
      recursive: true,
    });
  }
  try {
    return spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$1"
package_root() { printf '%s/lib/node_modules/openclaw\\n' "$npm_config_prefix"; }
SCENARIO=plugin-deps-cleanup
seed_legacy_plugin_dependency_debris
assert_legacy_plugin_dependency_debris_present
if [ "$2" != keep-package ]; then
  rm -rf "$(package_root)"
  mkdir -p "$(package_root)"
fi
if [ "$2" = remove-shared ]; then
  rm "$OPENCLAW_STATE_DIR/plugin-runtime-deps/discord-upgrade-survivor/node_modules/openclaw-upgrade-survivor-dep/package.json"
fi
# Later phases use the recorded seed, not the request or replaced package inventory.
OPENCLAW_UPGRADE_SURVIVOR_PLUGIN_DEPS_CLEANUP_PLUGINS=absent-after-update
assert_legacy_plugin_dependency_debris_cleaned
assert_legacy_plugin_dependency_debris_cleaned
`,
        "bash",
        resolve("scripts/e2e/lib/upgrade-survivor/plugin-dependency-fixtures.sh"),
        mutation ?? "",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_prefix: prefix,
          OPENCLAW_STATE_DIR: join(root, "state"),
          OPENCLAW_UPGRADE_SURVIVOR_PLUGIN_DEPS_CLEANUP_PLUGINS: requested,
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("upgrade dependency fixture ownership", () => {
  it.each([
    ["discord", "dist/extensions"],
    ["absent-fixture discord another-absent", "dist/extensions"],
    ["discord absent-fixture", "extensions"],
  ])("preserves the actual seeded set for %s in %s", (requested, packagedDir) => {
    const result = runDependencyFixture(requested, packagedDir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Seeded legacy plugin dependency debris for configured plugin: discord",
    );
  });

  it("rejects a request with no packaged plugins to seed", () => {
    const result = runDependencyFixture("absent-fixture");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not find a requested packaged plugin directory");
  });

  it.each([
    ["remove-shared", "shared plugin dependency state was removed"],
    ["keep-package", "legacy plugin dependency debris survived"],
  ] as const)("rejects %s after a mixed-domain seed", (mutation, message) => {
    const result = runDependencyFixture("discord absent-fixture", "dist/extensions", mutation);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
