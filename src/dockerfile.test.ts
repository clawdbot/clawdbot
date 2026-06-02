import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerReleaseWorkflowPath = join(repoRoot, ".github/workflows/docker-release.yml");
const fullReleaseValidationWorkflowPath = join(
  repoRoot,
  ".github/workflows/full-release-validation.yml",
);
const dockerSetupDockerfilePaths = ["Dockerfile", "scripts/docker/sandbox/Dockerfile"] as const;
const pnpmWorkspacePath = join(repoRoot, "pnpm-workspace.yaml");

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

describe("Dockerfile", () => {
  it("does not force an external Dockerfile frontend pull", async () => {
    for (const path of dockerSetupDockerfilePaths) {
      const dockerfile = await readFile(join(repoRoot, path), "utf8");
      expect(dockerfile, path).not.toMatch(/^#\s*syntax=/m);
    }
  });

  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime");
    expect(dockerfile).toContain("FROM base-runtime");
    expect(dockerfile).toContain("current multi-arch manifest list entries");
    expect(dockerfile).not.toContain("current amd64 entry");
    expect(dockerfile).not.toContain("OPENCLAW_VARIANT");
  });

  it("installs CA certificates in the slim runtime stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const collapsed = collapseDockerContinuations(dockerfile);
    const runtimeIndex = collapsed.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const caInstallIndex = collapsed.indexOf(
      "ca-certificates curl git hostname lsof openssl procps python3",
    );

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(caInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(caInstallIndex).toBeLessThan(collapsed.indexOf("RUN chown node:node /app"));
    expect(collapsed).toMatch(/apt-get install -y --no-install-recommends\s+ca-certificates/);
    expect(collapsed).toContain("update-ca-certificates");
  });

  it("installs python3 and tini in the slim runtime stage", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const runtimeIndex = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const pythonInstallIndex = dockerfile.indexOf(
      "ca-certificates curl git hostname lsof openssl procps python3",
    );

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(pythonInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(pythonInstallIndex).toBeLessThan(dockerfile.indexOf("RUN chown node:node /app"));
    expect(dockerfile).toContain(
      "ca-certificates curl git hostname lsof openssl procps python3 tini",
    );
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "-s", "--"]');
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG OPENCLAW_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
  });

  it("uses the Docker target platform for pnpm install and prune", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile \\");
    const storeSeedIndex = dockerfile.indexOf(
      "pnpm list --prod --depth Infinity --json | node scripts/list-prod-store-packages.mjs | xargs -r pnpm store add",
    );
    const pruneIndex = dockerfile.indexOf("CI=true pnpm prune --prod \\");

    expect(installIndex).toBeGreaterThan(-1);
    expect(storeSeedIndex).toBeGreaterThan(installIndex);
    expect(storeSeedIndex).toBeLessThan(pruneIndex);
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("--config.offline=true");
    expect(dockerfile.split("--config.supportedArchitectures.os=linux").length - 1).toBe(2);
    expect(
      dockerfile.split("--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"").length -
        1,
    ).toBe(2);
    expect(dockerfile.split("--config.supportedArchitectures.libc=glibc").length - 1).toBe(2);
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("Verifying critical native addons");
    expect(dockerfile).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(dockerfile).toContain(
      "node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    );
    expect(dockerfile).toContain("matrix-sdk-crypto native addon missing after retries");
    expect(dockerfile).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("copies install workspace manifests before pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const postinstallIndex = dockerfile.indexOf("COPY scripts/postinstall-bundled-plugins.mjs");
    const prepareIndex = dockerfile.indexOf("scripts/prepare-git-hooks.mjs");
    const distImportHelperIndex = dockerfile.indexOf(
      "COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs",
    );
    const packageManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/packages/ ./packages/",
    );
    const extensionManifestIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/",
    );

    expect(postinstallIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(distImportHelperIndex).toBeGreaterThan(-1);
    expect(packageManifestIndex).toBeGreaterThan(-1);
    expect(extensionManifestIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("for manifest in /tmp/packages/*/package.json");
    expect(dockerfile).toContain(
      `if [ -f "/tmp/\${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json" ]; then`,
    );
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(prepareIndex).toBeLessThan(installIndex);
    expect(distImportHelperIndex).toBeLessThan(installIndex);
    expect(packageManifestIndex).toBeLessThan(installIndex);
    expect(extensionManifestIndex).toBeLessThan(installIndex);
  });

  it("copies root package lifecycle scripts before pnpm install", async () => {
    const [dockerfile, packageJsonText] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile(join(repoRoot, "package.json"), "utf8"),
    ]);
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const packageJson = JSON.parse(packageJsonText) as {
      scripts?: Record<string, string>;
    };
    const installLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"] as const;

    for (const lifecycleScript of installLifecycleScripts) {
      const command = packageJson.scripts?.[lifecycleScript];
      const scriptPath = command?.match(/\bnode\s+(scripts\/[^\s]+)/)?.[1];
      if (!scriptPath) {
        continue;
      }

      const copyIndex = dockerfile.indexOf(scriptPath);
      expect(
        copyIndex,
        `${lifecycleScript} must copy ${scriptPath} before pnpm install`,
      ).toBeGreaterThan(-1);
      expect(
        copyIndex,
        `${lifecycleScript} must copy ${scriptPath} before pnpm install`,
      ).toBeLessThan(installIndex);
    }
  });

  it("does not let pnpm resync the full source workspace during Docker build scripts", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain(
      "NODE_OPTIONS=--max-old-space-size=8192 pnpm_config_verify_deps_before_run=false pnpm build:docker",
    );
    expect(dockerfile).toContain(
      "pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle",
    );
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm ui:build");
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm qa:lab:build");
  });

  it("prunes runtime dependencies and omitted plugin packages after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain(
      "Opt-in plugin dependencies at build time (space- or comma-separated directory names).",
    );
    expect(dockerfile).toContain(
      'Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .',
    );
    expect(dockerfile).toContain(
      "RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \\",
    );
    expect(dockerfile).toContain("COPY --from=workspace-deps /out/packages/ ./packages/");
    expect(dockerfile).toContain(
      "COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/",
    );
    expect(dockerfile).toContain(
      'OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs',
    );
    expect(dockerfile).toContain("CI=true pnpm prune --prod \\");
    expect(dockerfile.indexOf("CI=true pnpm prune --prod \\")).toBeLessThan(
      dockerfile.indexOf(
        'OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs',
      ),
    );
    expect(dockerfile).toContain("--config.offline=true");
    expect(dockerfile).toContain("--config.supportedArchitectures.os=linux");
    expect(dockerfile).toContain(
      "--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"",
    );
    expect(dockerfile).toContain("--config.supportedArchitectures.libc=glibc");
    expect(dockerfile).not.toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).not.toContain("write-runtime-pnpm-workspace");
    expect(dockerfile).not.toContain(
      `npm install --prefix "${BUNDLED_PLUGIN_ROOT_DIR}/$ext" --omit=dev --silent`,
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps runtime workspace templates in final images", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const templatesCopyIndex = dockerfile.indexOf(
      "COPY --from=runtime-assets --chown=node:node /app/src/agents/templates ./src/agents/templates",
      runtimeStageIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    expect(templatesCopyIndex).toBeGreaterThan(runtimeStageIndex);
    expect(templatesCopyIndex).toBeLessThan(userIndex);
  });

  it("keeps package manager patch files in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const pnpmWorkspace = YAML.parse(await readFile(pnpmWorkspacePath, "utf8")) as {
      patchedDependencies?: Record<string, string>;
    };
    const pruneProd = "CI=true pnpm prune --prod";
    const finalWorkspaceCopy =
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .";

    expect(Object.keys(pnpmWorkspace.patchedDependencies ?? {})).not.toHaveLength(0);
    expect(dockerfile).not.toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).not.toContain("write-runtime-pnpm-workspace");
    expect(dockerfile).not.toContain("pnpm_config_frozen_lockfile=false");
    expect(dockerfile).toContain(finalWorkspaceCopy);
    expect(dockerfile.indexOf(pruneProd)).toBeLessThan(dockerfile.indexOf(finalWorkspaceCopy));
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps the Codex plugin in official Docker release images", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");
    const releaseKeepList = "OPENCLAW_EXTENSIONS=diagnostics-otel,codex";

    expect(workflow.match(new RegExp(releaseKeepList, "g"))).toHaveLength(4);
    expect(workflow).not.toContain("OPENCLAW_EXTENSIONS=diagnostics-otel\n");
  });

  it("publishes official Docker browser images with baked Chromium", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("Build and push amd64 browser image");
    expect(workflow).toContain("Build and push arm64 browser image");
    expect(workflow).toContain("OPENCLAW_INSTALL_BROWSER=1");
    expect(workflow).toContain('${IMAGE}:${version}-browser"');
    expect(workflow).toContain('${IMAGE}:latest-browser"');
    expect(workflow).toContain('${IMAGE}:main-browser"');
    expect(workflow).not.toContain("main-browser-amd64");
    expect(workflow).not.toContain("main-browser-arm64");
    expect(workflow).toContain("Smoke test amd64 browser image");
    expect(workflow).toContain("Smoke test arm64 browser image");
    expect(workflow).toContain("chrome-headless-shell");
    expect(workflow).toContain("grep -q '^ARG OPENCLAW_INSTALL_BROWSER' Dockerfile");
    expect(workflow).toContain("if: steps.tags.outputs.browser != ''");
    expect(workflow).toContain('git show "${SOURCE_REF}:Dockerfile"');
    expect(workflow).toContain('if [[ -n "${BROWSER_TAGS}" ]]; then');
  });

  it("smokes runtime workspace templates before Docker release manifests publish", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("Smoke test amd64 runtime workspace templates");
    expect(workflow).toContain("Smoke test arm64 runtime workspace templates");
    expect(workflow).toContain("test -f /app/src/agents/templates/HEARTBEAT.md");
    expect(workflow).toContain('grep -F "Missing workspace template:"');
    expect(workflow).toContain('test -f "${temp_root}/home/.openclaw/workspace/HEARTBEAT.md"');
  });

  it("keeps only the runtime-assets prune proof in full release validation", async () => {
    const workflow = await readFile(fullReleaseValidationWorkflowPath, "utf8");

    expect(workflow).toContain("Verify Docker runtime-assets prune path");
    expect(workflow).toContain("--target runtime-assets");
    expect(workflow).not.toContain("Build and smoke test final Docker runtime image");
    expect(workflow).not.toContain("test -f /app/src/agents/templates/HEARTBEAT.md");
    expect(workflow).not.toContain('grep -F "Missing workspace template:"');
    expect(workflow).not.toContain('test -f "${temp_root}/home/.openclaw/workspace/HEARTBEAT.md"');
    expect(workflow).not.toContain("scripts/docker/runtime-workspace-template-smoke.sh");
  });

  it("does not override bundled plugin discovery in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain(`ARG OPENCLAW_BUNDLED_PLUGIN_DIR=${BUNDLED_PLUGIN_ROOT_DIR}`);
    expect(dockerfile).not.toMatch(/^\s*ENV\b[^\n]*\bOPENCLAW_BUNDLED_PLUGINS_DIR\b/m);
  });

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("Docker GPG fingerprint awk uses correct quoting for OPENCLAW_SANDBOX=1 build", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const anchor = dockerfile.indexOf(
      "curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    expect(anchor).toBeGreaterThan(-1);
    const slice = dockerfile.slice(anchor);
    expect(slice).toContain("docker_gpg_pub_count=");
    expect(slice).toContain('$1 == "pub"');
    expect(slice).not.toContain('\\"pub\\"');
    const pubCountIdx = slice.indexOf("docker_gpg_pub_count=");
    const fpIdx = slice.indexOf("actual_fingerprint=");
    const dearmorIdx = slice.indexOf("gpg --dearmor");
    expect(pubCountIdx).toBeLessThan(fpIdx);
    expect(fpIdx).toBeLessThan(dearmorIdx);
    expect(slice).toContain('[ "$docker_gpg_pub_count" != "1" ]');
  });

  it("keeps runtime pnpm available", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV COREPACK_HOME=/usr/local/share/corepack");
    expect(dockerfile).toContain(
      'corepack prepare "$(node -p "require(\'./package.json\').packageManager")" --activate',
    );
  });

  it("pre-creates named-volume mount points before switching to the node user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const parentConfigDirIndex = dockerfile.indexOf(
      "RUN install -d -m 0755 -o node -g node /home/node/.config",
      runtimeStageIndex,
    );
    const stateDirIndex = dockerfile.indexOf(
      "install -d -m 0700 -o node -g node \\",
      parentConfigDirIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    // Regression: /home/node/.config parent must be created with node ownership
    // before the leaf .config/openclaw dir (issue #85968).
    expect(parentConfigDirIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(-1);
    expect(parentConfigDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(parentConfigDirIndex).toBeLessThan(stateDirIndex);
    expect(stateDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(stateDirIndex).toBeLessThan(userIndex);
    expect(dockerfile).not.toContain("mkdir -p /home/node/.openclaw");
    expect(dockerfile).toContain("/home/node/.openclaw/workspace");
    expect(dockerfile).toContain("/home/node/.config/openclaw");
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700'",
    );
    // Regression: assert parent /home/node/.config is also node-owned (issue #85968).
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'",
    );
  });
});
