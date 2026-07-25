// Tests Dockerfile metadata and expected install commands.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerInstallDocsPath = join(repoRoot, "docs/install/docker.md");
const dockerReleaseWorkflowPath = join(repoRoot, ".github/workflows/docker-release.yml");
const fullReleaseValidationWorkflowPath = join(
  repoRoot,
  ".github/workflows/full-release-validation.yml",
);
const dockerSetupDockerfilePaths = ["Dockerfile", "scripts/docker/sandbox/Dockerfile"] as const;

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
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="docker.io/library/node:24-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_BUN_IMAGE="docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"',
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
      "node scripts/list-prod-store-packages.mjs | xargs -r pnpm store add",
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

  it("uses portable copies for workspace dependency inputs", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const workspaceDepsStart = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps",
    );
    const workspaceDepsEnd = dockerfile.indexOf("FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary");

    expect(workspaceDepsStart).toBeGreaterThan(-1);
    expect(workspaceDepsEnd).toBeGreaterThan(workspaceDepsStart);

    const workspaceDeps = dockerfile.slice(workspaceDepsStart, workspaceDepsEnd);
    const extractionIndex = workspaceDeps.indexOf(
      'RUN mkdir -p /out/packages "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}"',
    );
    const inputCopies = [
      "COPY scripts/lib/docker-plugin-selection.mjs /tmp/docker-plugin-selection.mjs",
      "COPY packages /tmp/packages",
      "COPY ${OPENCLAW_BUNDLED_PLUGIN_DIR} /tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}",
    ];

    expect(extractionIndex).toBeGreaterThan(-1);
    for (const copy of inputCopies) {
      const copyIndex = workspaceDeps.indexOf(copy);
      expect(copyIndex, copy).toBeGreaterThan(-1);
      expect(copyIndex, copy).toBeLessThan(extractionIndex);
    }
    expect(workspaceDeps).not.toContain("--mount=type=bind");
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
      'node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS"',
    );
    expect(dockerfile).toContain("done < /out/openclaw-selected-plugin-dirs");
    expect(dockerfile).toContain(`if [ -f "$ext_dir/package.json" ]; then`);
    expect(dockerfile).toContain(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(prepareIndex).toBeLessThan(installIndex);
    expect(distImportHelperIndex).toBeLessThan(installIndex);
    expect(packageManifestIndex).toBeLessThan(installIndex);
    expect(extensionManifestIndex).toBeLessThan(installIndex);
  });

  it("keeps validated plugin selection outside the build-context copy destination", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const selectionCopyIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    const buildContextCopyIndex = dockerfile.indexOf("COPY . .");

    expect(selectionCopyIndex).toBeGreaterThan(-1);
    expect(buildContextCopyIndex).toBeGreaterThan(selectionCopyIndex);
    expect(dockerfile).not.toContain("/app/.openclaw-selected-plugin-dirs");
    expect(dockerfile).not.toContain("./.openclaw-selected-plugin-dirs");
    expect(dockerfile).toContain("grep -qx 'matrix' /tmp/openclaw-selected-plugin-dirs");
    expect(dockerfile).toContain(
      'selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"',
    );
    expect(dockerfile).toContain('OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)"');
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
    const collapsed = collapseDockerContinuations(dockerfile);
    const qaLabExtensionCheckIndex = collapsed.indexOf("grep -qx 'qa-lab'");
    const privateQaExportIndex = collapsed.indexOf(
      "export OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1",
    );
    const buildDockerIndex = collapsed.indexOf(
      'OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS="$selected_plugin_dirs" OPENCLAW_RUN_NODE_SKIP_DTS_BUILD="$OPENCLAW_DOCKER_BUILD_SKIP_DTS" OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB="$OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB" NODE_OPTIONS="$OPENCLAW_DOCKER_BUILD_NODE_OPTIONS" pnpm_config_verify_deps_before_run=false pnpm build:docker',
    );
    const qaLabBuildIndex = collapsed.indexOf(
      "pnpm_config_verify_deps_before_run=false pnpm qa:lab:build",
    );
    const qaLabDistCopyIndex = collapsed.indexOf(
      "cp -R extensions/qa-lab/web/dist dist/extensions/qa-lab/web/dist",
    );
    const runtimeAssetsIndex = collapsed.indexOf("FROM build AS runtime-assets");

    expect(qaLabExtensionCheckIndex).toBeGreaterThan(-1);
    expect(buildDockerIndex).toBeGreaterThan(-1);
    expect(collapsed).not.toContain(
      'OPENCLAW_DOCKER_BUILD_EXTENSIONS="$OPENCLAW_EXTENSIONS" OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=',
    );
    expect(qaLabBuildIndex).toBeGreaterThan(-1);
    expect(qaLabDistCopyIndex).toBeGreaterThan(-1);
    expect(runtimeAssetsIndex).toBeGreaterThan(-1);
    expect(privateQaExportIndex).toBeGreaterThan(qaLabExtensionCheckIndex);
    expect(privateQaExportIndex).toBeLessThan(buildDockerIndex);
    expect(qaLabBuildIndex).toBeGreaterThan(buildDockerIndex);
    expect(qaLabDistCopyIndex).toBeGreaterThan(qaLabBuildIndex);
    expect(qaLabDistCopyIndex).toBeLessThan(runtimeAssetsIndex);
    expect(dockerfile).toContain(
      "pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle",
    );
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm ui:build");
    expect(dockerfile).toContain("pnpm_config_verify_deps_before_run=false pnpm qa:lab:build");
  });

  it("shares public source provenance across backend and Control UI builds", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const commitArgIndex = dockerfile.indexOf('ARG GIT_COMMIT=""');
    const timestampArgIndex = dockerfile.indexOf('ARG OPENCLAW_BUILD_TIMESTAMP=""');
    const provenanceEnvIndex = dockerfile.indexOf("ENV GIT_COMMIT=${GIT_COMMIT}");
    const backendBuildIndex = dockerfile.indexOf("pnpm build:docker");
    const uiBuildIndex = dockerfile.indexOf("pnpm ui:build");

    expect(commitArgIndex).toBeGreaterThan(installIndex);
    expect(timestampArgIndex).toBeGreaterThan(commitArgIndex);
    expect(provenanceEnvIndex).toBeGreaterThan(timestampArgIndex);
    expect(dockerfile).toContain("OPENCLAW_BUILD_TIMESTAMP=${OPENCLAW_BUILD_TIMESTAMP}");
    expect(dockerfile).toContain('OPENCLAW_BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(backendBuildIndex).toBeGreaterThan(provenanceEnvIndex);
    expect(uiBuildIndex).toBeGreaterThan(backendBuildIndex);
  });

  it("documents provenance arguments for manual source builds", async () => {
    const docs = await readFile(dockerInstallDocsPath, "utf8");
    const selectedPluginStart = docs.indexOf("### Source-built images with selected plugins");
    const selectedPluginEnd = docs.indexOf("### Observability", selectedPluginStart);
    const selectedPluginDocs = docs.slice(selectedPluginStart, selectedPluginEnd);

    expect(docs).toContain('BUILD_GIT_COMMIT="$(git rev-parse HEAD)"');
    expect(docs).toContain('BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(docs).toContain('--build-arg "GIT_COMMIT=${BUILD_GIT_COMMIT}"');
    expect(docs).toContain('--build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}"');
    expect(docs).toContain("The Docker context excludes `.git`.");
    expect(selectedPluginStart).toBeGreaterThan(-1);
    expect(selectedPluginEnd).toBeGreaterThan(selectedPluginStart);
    expect(selectedPluginDocs).toContain('SOURCE_SHA="$(git rev-parse HEAD)"');
    expect(selectedPluginDocs).toContain('BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(selectedPluginDocs).toContain('--build-arg "GIT_COMMIT=${SOURCE_SHA}"');
    expect(selectedPluginDocs).toContain(
      '--build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}"',
    );
  });

  it("prunes runtime dependencies and omitted plugin packages after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_DOCKER_BUILD_NODE_OPTIONS="--max-old-space-size=8192"',
    );
    expect(dockerfile).toContain('ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=""');
    expect(dockerfile).toContain("ARG OPENCLAW_DOCKER_BUILD_SKIP_DTS=1");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain(
      "Opt-in plugin dependencies and supported runtime builds (space- or comma-separated ids).",
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
      'OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs',
    );
    expect(dockerfile).toContain("readlink -f /app/node_modules/@openclaw/ai");
    expect(dockerfile).toContain('mv "$ai_runtime_tmp/ai" /app/node_modules/@openclaw/ai');
    expect(dockerfile).toContain("CI=true pnpm prune --prod \\");
    expect(dockerfile.indexOf("CI=true pnpm prune --prod \\")).toBeLessThan(
      dockerfile.indexOf(
        'OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs',
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

  it("keeps build-stage workspace packages readable by non-root live tests", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const sourceCopyIndex = dockerfile.indexOf("COPY . .");
    const readabilityIndex = dockerfile.indexOf(
      "RUN find /app -path /app/node_modules -prune -o -exec chmod a+rX {} +",
    );
    const buildIndex = dockerfile.indexOf("pnpm build:docker");

    expect(sourceCopyIndex).toBeGreaterThan(-1);
    expect(readabilityIndex).toBeGreaterThan(sourceCopyIndex);
    expect(readabilityIndex).toBeLessThan(buildIndex);
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

  it("keeps package manager metadata in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const pruneProd = "CI=true pnpm prune --prod";
    const finalWorkspaceCopy =
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .";

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

  it("uses one source commit and timestamp for every official Docker artifact", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("resolve_build_provenance:");
    expect(workflow).toContain("built_at: ${{ steps.build_provenance.outputs.built_at }}");
    expect(workflow).toContain("source_sha: ${{ steps.build_provenance.outputs.source_sha }}");
    expect(workflow.match(/date -u \+%Y-%m-%dT%H:%M:%SZ/gu)).toHaveLength(1);
    expect(
      workflow.split("BUILD_TIMESTAMP: ${{ needs.resolve_build_provenance.outputs.built_at }}")
        .length - 1,
    ).toBe(2);
    expect(
      workflow.split("ref: ${{ needs.resolve_build_provenance.outputs.source_sha }}").length - 1,
    ).toBe(4);
    expect(
      workflow.split("GIT_COMMIT=${{ needs.resolve_build_provenance.outputs.source_sha }}").length -
        1,
    ).toBe(4);
    expect(
      workflow.split(
        "OPENCLAW_BUILD_TIMESTAMP=${{ needs.resolve_build_provenance.outputs.built_at }}",
      ).length - 1,
    ).toBe(4);
  });

  it("publishes official Docker browser images with baked Chromium", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("Build and push amd64 browser image");
    expect(workflow).toContain("Build and push arm64 browser image");
    expect(workflow).toContain("OPENCLAW_INSTALL_BROWSER=1");
    expect(workflow).toContain('${GHCR_IMAGE}:${version}-browser"');
    expect(workflow).toContain('${DOCKERHUB_IMAGE}:${version}-browser"');
    expect(workflow).not.toContain("main-browser-amd64");
    expect(workflow).not.toContain("main-browser-arm64");
    expect(workflow).toContain("Smoke test amd64 browser image");
    expect(workflow).toContain("Smoke test arm64 browser image");
    expect(workflow).toContain("chrome-headless-shell");
    expect(workflow).toContain("grep -q '^ARG OPENCLAW_INSTALL_BROWSER' Dockerfile");
    expect(workflow).toContain("if: steps.tags.outputs.browser != ''");
    expect(workflow).not.toContain('git show "${SOURCE_REF}:Dockerfile"');
    expect(workflow).toContain('if [[ -n "${BROWSER_TAGS}" ]]; then');
  });

  it("publishes official Docker releases to GHCR and Docker Hub", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("REGISTRY: ghcr.io");
    expect(workflow).toContain("DOCKERHUB_REGISTRY: docker.io");
    expect(workflow).toContain("DOCKERHUB_IMAGE_NAME: openclaw/openclaw");
    expect(workflow).toContain("Validate Docker Hub publish credentials");
    expect(workflow).toContain("DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets");
    expect(workflow).toContain("Login to GitHub Container Registry");
    expect(workflow).toContain("Login to Docker Hub");
    expect(workflow).toContain('images=("${GHCR_IMAGE}" "${DOCKERHUB_IMAGE}")');
    expect(workflow).toContain("DOCKERHUB_TAGS: ${{ steps.tags.outputs.dockerhub }}");
    expect(workflow).toContain("${DOCKERHUB_IMAGE}:${version}-amd64");
    expect(workflow).toContain("${DOCKERHUB_IMAGE}:${version}-arm64");
    expect(workflow).toContain("DOCKERHUB_MULTI_REFS: ${{ steps.refs.outputs.dockerhub_multi }}");
  });

  it("validates release tags before immutable Docker publication", async () => {
    const workflow = await readFile(dockerReleaseWorkflowPath, "utf8");

    expect(workflow).toContain("Existing stable, extended-stable, or beta release tag");
    expect(workflow).toContain('! "${RELEASE_TAG}" =~ ^v[0-9]{4}');
    expect(workflow).toContain("(-(beta\\.)?[1-9][0-9]*)?");
    expect(workflow).toContain("${DOCKERHUB_IMAGE}:${version}");
    expect(workflow).toContain("${DOCKERHUB_IMAGE}:${version}-slim");
    expect(workflow).toContain("${DOCKERHUB_IMAGE}:${version}-browser");
    expect(workflow).toContain("node workflow-source/scripts/lib/docker-release-policy.mjs");
    expect(workflow).not.toContain("needs.resolve_release_policy.outputs.default_aliases");
    expect(workflow).not.toContain("needs.resolve_release_policy.outputs.slim_aliases");
    expect(workflow).not.toContain("needs.resolve_release_policy.outputs.browser_aliases");
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
    expect(dockerfile).toMatch(
      /curl -fsSL --connect-timeout 10 --max-time 120\s+https:\/\/download\.docker\.com\/linux\/debian\/gpg -o \/tmp\/docker\.gpg\.asc/u,
    );
    const anchor = dockerfile.indexOf(
      "https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
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
