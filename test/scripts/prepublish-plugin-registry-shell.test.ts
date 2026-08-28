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

function createTarball(
  root: string,
  outputDir: string,
  name: string,
  filename: string,
  version = VERSION,
): string {
  const packageRoot = join(root, "staging", filename, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name, version })}\n`);
  const tarball = join(outputDir, filename);
  execFileSync("tar", ["-czf", tarball, "-C", join(packageRoot, ".."), "package"]);
  return tarball;
}

describe("prepublish plugin registry shell helper", () => {
  it("derives the immutable Docker mount contract from the registry artifact", () => {
    const root = tempDirs.make("openclaw-prepublish-registry-mount-");
    const manifestPath = join(root, "prepublish-plugin-registry.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ candidateVersion: VERSION, packages: [], sourceSha: SOURCE_SHA })}\n`,
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source "$HELPER"
openclaw_prepublish_plugin_registry_configure_docker_args "$ARTIFACT_DIR"
printf '%s\n' "\${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]}"
`,
      ],
      { encoding: "utf8", env: { ...process.env, ARTIFACT_DIR: root, HELPER: SCRIPT } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`OPENCLAW_DOCKER_E2E_SELECTED_SHA=${SOURCE_SHA}`);
    expect(result.stdout).toContain(
      `OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=${VERSION}`,
    );
    expect(result.stdout).toContain(`${root}:/tmp/openclaw-prepublish-plugin-registry:ro`);
    expect(result.stdout).toContain(
      `OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256=${sha256(manifestPath)}`,
    );
  });

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
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="$ARTIFACT_DIR"
export OPENCLAW_DOCKER_E2E_SELECTED_SHA="$SOURCE_SHA"
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION="$VERSION"
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="$MANIFEST_SHA256"
openclaw_prepublish_plugin_registry_start_mounted \
  "$REGISTRY_ROOT" registry_pid '["@openclaw/codex"]' \
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

  it.each(["2026.8.1", "2026.8.1-2"])(
    "resolves stable candidate %s from an unversioned npm spec",
    (version) => {
      const root = tempDirs.make("openclaw-stable-prepublish-registry-shell-");
      const registryRoot = join(root, "registry");
      const discordTarball = createTarball(
        root,
        root,
        "@openclaw/discord",
        `openclaw-discord-${version}.tgz`,
        version,
      );
      const fixtureVersion = "2026.5.2";
      const braveTarball = createTarball(
        root,
        root,
        "@openclaw/brave-plugin",
        `openclaw-brave-${fixtureVersion}.tgz`,
        fixtureVersion,
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
openclaw_prepublish_plugin_registry_start \
  "" "" "$VERSION" "" "$REGISTRY_ROOT" registry_pid \
  "@openclaw/discord" "$VERSION" "$DISCORD_TARBALL" \
  "@openclaw/brave-plugin" "$FIXTURE_VERSION" "$BRAVE_TARBALL"
test "$(npm view @openclaw/discord version)" = "$VERSION"
test "$(npm view @openclaw/brave-plugin version)" = "$FIXTURE_VERSION"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BRAVE_TARBALL: braveTarball,
            DISCORD_TARBALL: discordTarball,
            FIXTURE_VERSION: fixtureVersion,
            HELPER: SCRIPT,
            REGISTRY_ROOT: registryRoot,
            VERSION: version,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
