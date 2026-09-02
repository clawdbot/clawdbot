import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1-beta.1";
const BASELINE_VERSION = "2026.7.1";
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
  extra: Record<string, unknown> = {},
): string {
  const packageRoot = join(root, "staging", filename, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ ...extra, name, version })}\n`,
  );
  const tarball = join(outputDir, filename);
  execFileSync("tar", ["-czf", tarball, "-C", join(packageRoot, ".."), "package"]);
  return tarball;
}

function registryFixture(root: string, names: string[]) {
  const artifactDir = join(root, "artifact");
  mkdirSync(artifactDir);
  const packages = names
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => {
      const tarball = `${name.replace(/^@/u, "").replace("/", "-")}.tgz`;
      const file = createTarball(
        root,
        artifactDir,
        name,
        tarball,
        VERSION,
        name === "openclaw" ? { dependencies: { "@openclaw/ai": VERSION } } : {},
      );
      return { name, version: VERSION, tarball, sha256: sha256(file) };
    });
  const manifestPath = join(artifactDir, "prepublish-plugin-registry.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "openclaw.prepublish-plugin-registry/v1",
      schemaVersion: 1,
      sourceSha: SOURCE_SHA,
      candidateVersion: VERSION,
      packages,
    }),
  );
  return {
    artifactDir,
    manifestPath,
    env: {
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: artifactDir,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: SOURCE_SHA,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: VERSION,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: sha256(manifestPath),
    },
  };
}

async function withPublishedRegistry(root: string, run: (url: string) => void | Promise<void>) {
  const portFile = join(root, "upstream-port");
  const args = ["openclaw", "@openclaw/ai"].flatMap((name, index) => [
    name,
    BASELINE_VERSION,
    createTarball(
      root,
      root,
      name,
      `baseline-${index}.tgz`,
      BASELINE_VERSION,
      name === "openclaw" ? { dependencies: { "@openclaw/ai": BASELINE_VERSION } } : {},
    ),
  ]);
  const server = spawn(
    process.execPath,
    [resolve("scripts/e2e/lib/plugins/npm-registry-server.mjs"), portFile, ...args],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_PORT: "0",
        OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
        OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "",
        OPENCLAW_NPM_REGISTRY_DIST_TAGS: "",
      },
    },
  );
  const closed = once(server, "close");
  try {
    await vi.waitFor(() => expect(existsSync(portFile)).toBe(true));
    await run(`http://127.0.0.1:${readFileSync(portFile, "utf8")}`);
  } finally {
    server.kill("SIGTERM");
    await closed;
  }
}

describe("prepublish plugin registry shell helper", () => {
  it("retries failed upstream metadata while preserving published and candidate versions", async () => {
    const root = tempDirs.make("openclaw-prepublish-registry-retry-");
    const fixture = registryFixture(root, ["@openclaw/ai"]);
    let requests = 0;
    const upstream = createServer((_request, response) => {
      requests += 1;
      response.writeHead(requests === 1 ? 503 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "@openclaw/ai",
          "dist-tags": { latest: BASELINE_VERSION },
          versions: { [BASELINE_VERSION]: { name: "@openclaw/ai", version: BASELINE_VERSION } },
        }),
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing upstream address");
    }
    const child = spawn(
      "bash",
      [
        resolve(SCRIPT),
        process.execPath,
        "--input-type=module",
        "-e",
        `
const url = process.env.NPM_CONFIG_REGISTRY + "/@openclaw%2Fai";
const first = await fetch(url);
await first.text();
const second = await fetch(url);
const body = await second.text();
console.log(JSON.stringify({ url, first: first.status, second: second.status, body }));
`,
      ],
      {
        env: {
          ...process.env,
          ...fixture.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const [code] = await closed;
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({ first: 500, second: 200 });
      const metadata = JSON.parse(result.body);
      expect(Object.keys(metadata.versions).toSorted()).toEqual([BASELINE_VERSION, VERSION]);
      expect(metadata["dist-tags"].latest).toBe(BASELINE_VERSION);
      expect(requests).toBe(2);
      await expect(fetch(result.url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      child.kill("SIGTERM");
      await closed;
      upstream.closeAllConnections();
      const stopped = once(upstream, "close");
      upstream.close();
      await stopped;
    }
  });

  it("installs a published baseline before the exact candidate and reaps its registry on failure", async () => {
    const root = tempDirs.make("openclaw-prepublish-command-");
    const fixture = registryFixture(root, ["openclaw", "@openclaw/ai"]);
    const registryUrl = join(root, "registry-url");
    await withPublishedRegistry(root, async (upstream) => {
      const result = spawnSync(
        "bash",
        [
          resolve(SCRIPT),
          "bash",
          "-c",
          `
set -euo pipefail
test "$BUN_CONFIG_REGISTRY" = "$NPM_CONFIG_REGISTRY"
npm install --prefix "$INSTALL_DIR" openclaw@latest --ignore-scripts --no-fund --no-audit --package-lock=false --userconfig=/dev/null --cache "$INSTALL_DIR/cache"
node -e 'const assert=require("node:assert/strict"); for(const name of ["openclaw", "@openclaw/ai"]) assert.equal(require(process.env.INSTALL_DIR+"/node_modules/"+name+"/package.json").version, process.env.BASELINE_VERSION);'
npm install --prefix "$INSTALL_DIR" "$ROOT_TARBALL" --ignore-scripts --no-fund --no-audit --package-lock=false --userconfig=/dev/null --cache "$INSTALL_DIR/cache"
node -e 'const fs=require("node:fs"); const root=require(process.env.INSTALL_DIR+"/node_modules/openclaw/package.json"); const ai=require(process.env.INSTALL_DIR+"/node_modules/@openclaw/ai/package.json"); if(root.dependencies["@openclaw/ai"] !== ai.version) process.exit(1); fs.writeFileSync(process.env.REGISTRY_URL_FILE, process.env.NPM_CONFIG_REGISTRY);'
exit 17
`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            ...fixture.env,
            OPENCLAW_NPM_REGISTRY_UPSTREAM: upstream,
            BASELINE_VERSION,
            INSTALL_DIR: join(root, "install"),
            ROOT_TARBALL: join(fixture.artifactDir, "openclaw.tgz"),
            REGISTRY_URL_FILE: registryUrl,
          },
        },
      );

      expect(result.status, result.stdout + result.stderr).toBe(17);
      await expect(
        fetch(readFileSync(registryUrl, "utf8"), { signal: AbortSignal.timeout(1_000) }),
      ).rejects.toThrow();
    });
  });

  it("carries verified registry bytes and their expected identity into the Docker context", () => {
    const root = tempDirs.make("openclaw-prepublish-build-context-");
    const fixture = registryFixture(root, ["openclaw", "@openclaw/ai"]);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source "$PACKAGE_HELPER"
docker_e2e_prepare_package_context "$ROOT_TARBALL"
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...fixture.env,
          TMPDIR: root,
          PACKAGE_HELPER: resolve("scripts/lib/docker-e2e-package.sh"),
          ROOT_TARBALL: join(fixture.artifactDir, "openclaw.tgz"),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const context = result.stdout.trim();
    expect(JSON.parse(readFileSync(join(context, "registry-identity.json"), "utf8"))).toEqual({
      sourceSha: SOURCE_SHA,
      candidateVersion: VERSION,
      manifestSha256: sha256(fixture.manifestPath),
    });
    expect(readFileSync(join(context, "prepublish-plugin-registry", "openclaw-ai.tgz"))).toEqual(
      readFileSync(join(fixture.artifactDir, "openclaw-ai.tgz")),
    );
    expect(readFileSync(join(context, "openclaw-current.tgz"))).toEqual(
      readFileSync(join(fixture.artifactDir, "openclaw.tgz")),
    );
  });

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

  it("verifies and serves every artifact package plus caller-owned fixtures", async () => {
    const root = tempDirs.make("openclaw-prepublish-registry-shell-");
    const { artifactDir, manifestPath } = registryFixture(root, [
      "@openclaw/codex",
      "@openclaw/telegram",
    ]);
    const registryRoot = join(root, "registry");
    const extraTarball = createTarball(root, root, "@openclaw/brave-plugin", "brave-fixture.tgz");

    await withPublishedRegistry(root, (upstream) => {
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
            OPENCLAW_NPM_REGISTRY_UPSTREAM: upstream,
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
