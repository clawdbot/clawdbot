import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1-beta.1";
const SCRIPT = "scripts/e2e/lib/prepublish-plugin-registry.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createTarball(root: string, outputDir: string, name: string, filename: string): string {
  const packageRoot = join(root, "staging", filename, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: VERSION })}\n`,
  );
  const tarball = join(outputDir, filename);
  execFileSync("tar", ["-czf", tarball, "-C", join(packageRoot, ".."), "package"]);
  return tarball;
}

describe("prepublish plugin registry shell helper", () => {
  it("verifies and serves every artifact package plus caller-owned fixtures", () => {
    const root = tempDirs.make("openclaw-prepublish-registry-shell-");
    const artifactDir = join(root, "artifact");
    const registryRoot = join(root, "registry");
    mkdirSync(artifactDir);
    const codexFilename = "openclaw-codex-2026.8.1-beta.1.tgz";
    const telegramFilename = "openclaw-telegram-2026.8.1-beta.1.tgz";
    const codexTarball = createTarball(root, artifactDir, "@openclaw/codex", codexFilename);
    const telegramTarball = createTarball(
      root,
      artifactDir,
      "@openclaw/telegram",
      telegramFilename,
    );
    const extraTarball = createTarball(root, root, "@openclaw/brave-plugin", "brave-fixture.tgz");
    const manifestPath = join(artifactDir, "prepublish-plugin-registry.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        candidateVersion: VERSION,
        packages: [
          {
            name: "@openclaw/codex",
            sha256: sha256(codexTarball),
            tarball: codexFilename,
            version: VERSION,
          },
          {
            name: "@openclaw/telegram",
            sha256: sha256(telegramTarball),
            tarball: telegramFilename,
            version: VERSION,
          },
        ],
        schema: "openclaw.prepublish-plugin-registry/v1",
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
      })}\n`,
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source "$HELPER"
registry_pid=""
cleanup() {
  if [ -n "$registry_pid" ]; then
    kill "$registry_pid" >/dev/null 2>&1 || true
    wait "$registry_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_REQUIRED_PACKAGES_JSON='["@openclaw/codex"]'
openclaw_prepublish_plugin_registry_start \
  "$ARTIFACT_DIR" "$SOURCE_SHA" "$VERSION" "$MANIFEST_SHA256" \
  "$REGISTRY_ROOT" registry_pid \
  "@openclaw/brave-plugin" "$VERSION" "$EXTRA_TARBALL"
node <<'NODE'
const packages = ["@openclaw/codex", "@openclaw/telegram", "@openclaw/brave-plugin"];
for (const name of packages) {
  const response = await fetch(\`\${process.env.NPM_CONFIG_REGISTRY}/\${encodeURIComponent(name)}\`);
  if (!response.ok) throw new Error(\`\${name}: \${response.status}\`);
  const metadata = await response.json();
  if (metadata["dist-tags"].latest !== "0.0.0") throw new Error(\`\${name}: invalid latest\`);
  if (metadata["dist-tags"].beta !== process.env.VERSION) throw new Error(\`\${name}: invalid beta\`);
  if (!metadata.versions[process.env.VERSION]) throw new Error(\`\${name}: version missing\`);
}
if (process.env.NPM_CONFIG_REGISTRY !== process.env.npm_config_registry) {
  throw new Error("npm registry exports differ");
}
NODE
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ARTIFACT_DIR: artifactDir,
          EXTRA_TARBALL: extraTarball,
          HELPER: SCRIPT,
          MANIFEST_SHA256: sha256(manifestPath),
          REGISTRY_ROOT: registryRoot,
          SOURCE_SHA,
          VERSION,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
