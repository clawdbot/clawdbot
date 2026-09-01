// Tests Dockerfile metadata and expected install commands.
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerComposePath = join(repoRoot, "docker-compose.yml");
const dockerInstallDocsPath = join(repoRoot, "docs/install/docker.md");
const composeSetupScriptPath = join(repoRoot, "scripts/e2e/compose-setup.sh");
const fullReleaseValidationWorkflowPath = join(
  repoRoot,
  ".github/workflows/full-release-validation.yml",
);
const dockerSetupDockerfilePaths = ["Dockerfile", "scripts/docker/sandbox/Dockerfile"] as const;

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

function resolveOptionalAptPackages(dockerfile: string, env: NodeJS.ProcessEnv): string {
  const assignment = collapseDockerContinuations(dockerfile).match(
    /\bpackages="(\$\{OPENCLAW_IMAGE_APT_PACKAGES:-\$OPENCLAW_DOCKER_APT_PACKAGES\})";/u,
  )?.[1];
  if (!assignment) {
    throw new Error("Dockerfile optional apt package assignment is missing");
  }
  const script = `packages="${assignment}"; printf '%s' "$packages"`;
  return execFileSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env,
  });
}

describe("Dockerfile", () => {
  it("runs the built port-aware Gateway liveness probe", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const compose = await readFile(dockerComposePath, "utf8");

    expect(dockerfile).toContain('CMD ["node", "dist/docker-healthcheck.js"]');
    expect(dockerfile).not.toContain("127.0.0.1:18789/healthz");
    expect(compose).toContain('"dist/docker-healthcheck.js"');
    expect(compose).not.toContain("127.0.0.1:18789/healthz");
  });

  it("executes the documented Compose health command and validates JSON envelopes", async () => {
    const docs = await readFile(dockerInstallDocsPath, "utf8");
    const composeSetup = await readFile(composeSetupScriptPath, "utf8");
    const gatewayHealthCommand =
      'node dist/index.js gateway health --token "$OPENCLAW_GATEWAY_TOKEN"';

    expect(docs).toContain(`docker compose exec openclaw-gateway sh -lc '${gatewayHealthCommand}'`);
    expect(docs).not.toContain('node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"');
    expect(composeSetup).toContain(
      `"\${COMPOSE[@]}" exec -T openclaw-gateway sh -lc '${gatewayHealthCommand}'`,
    );
    expect(composeSetup.match(/gateway health --token "\$TOKEN" --json/g)).toHaveLength(2);
    expect(composeSetup).toContain('assert_gateway_health_json "gateway service"');
    expect(composeSetup).toContain('assert_gateway_health_json "CLI sidecar"');
    expect(composeSetup).toContain('--detail "gateway:documentedHealthCommand=passed"');
    expect(composeSetup).toContain('--detail "gateway:healthJsonEnvelope=passed"');
    expect(composeSetup).toContain('--detail "cli:healthJsonEnvelope=passed"');
    expect(composeSetup).not.toContain('dist/index.js health --token "$TOKEN"');
    expect(composeSetup).toContain('-v "$PROJECT_DIR:/target"');
    expect(composeSetup).toContain("rm -rf /target/* /target/.[!.]* /target/..?*");
  });

  it("does not force an external Dockerfile frontend pull", async () => {
    for (const path of dockerSetupDockerfilePaths) {
      const dockerfile = await readFile(join(repoRoot, path), "utf8");
      expect(dockerfile, path).not.toMatch(/^#\s*syntax=/m);
    }
  });

  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_BUN_IMAGE="docker.io/oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS dependency-inputs");
    expect(dockerfile).toContain("FROM dependency-inputs AS build");
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
      "ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3",
    );

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(caInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(caInstallIndex).toBeLessThan(collapsed.indexOf("RUN chown node:node /app"));
    expect(collapsed).toMatch(/apt-get install -y --no-install-recommends\s+ca-certificates/);
    expect(collapsed).toContain("update-ca-certificates");
  });

  it("installs Python, tini, and the llama-server OpenMP runtime in the slim stage", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const runtimeIndex = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const pythonInstallIndex = dockerfile.indexOf(
      "ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3",
    );

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(pythonInstallIndex).toBeGreaterThan(runtimeIndex);
    expect(pythonInstallIndex).toBeLessThan(dockerfile.indexOf("RUN chown node:node /app"));
    expect(dockerfile).toContain(
      "ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3 tini",
    );
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "-s", "--"]');
  });

  it.runIf(process.platform !== "win32").each([
    {
      name: "preferred packages",
      env: { OPENCLAW_IMAGE_APT_PACKAGES: "python3 wget" },
      expected: "python3 wget",
    },
    {
      name: "legacy packages when the preferred argument is empty",
      env: {
        OPENCLAW_IMAGE_APT_PACKAGES: "",
        OPENCLAW_DOCKER_APT_PACKAGES: "git curl jq",
      },
      expected: "git curl jq",
    },
    {
      name: "no packages when both arguments are absent",
      env: {},
      expected: "",
    },
    {
      name: "preferred packages when both arguments are present",
      env: {
        OPENCLAW_IMAGE_APT_PACKAGES: "python3",
        OPENCLAW_DOCKER_APT_PACKAGES: "git",
      },
      expected: "python3",
    },
  ])("resolves optional apt package args: $name", async ({ env, expected }) => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(resolveOptionalAptPackages(dockerfile, env)).toBe(expected);
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

  it("uses the Docker target platform for both frozen installs", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const installs = dockerfile.match(/^RUN .*pnpm install[^\n]+/gm) ?? [];

    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install).toContain("pnpm install --frozen-lockfile");
      expect(install).toContain("--config.supportedArchitectures.os=linux");
      expect(install).toContain(
        "--config.supportedArchitectures.cpu=\"$(node -p 'process.arch')\"",
      );
      expect(install).toContain("--config.supportedArchitectures.libc=glibc");
    }
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const [dockerfile, nativeCheck] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile(join(repoRoot, "scripts/docker/verify-native-addons.sh"), "utf8"),
    ]);
    expect(dockerfile.match(/^RUN sh scripts\/docker\/verify-native-addons.sh$/gm)).toHaveLength(2);
    expect(nativeCheck).toContain("grep -qx 'matrix' /tmp/openclaw-selected-plugin-dirs");
    expect(nativeCheck).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(nativeCheck).toContain(
      "node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    );
    expect(nativeCheck).toContain("matrix-sdk-crypto native addon missing after retries");
    expect(nativeCheck).not.toMatch(
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
    const importGrammarIndex = dockerfile.indexOf(
      "COPY scripts/lib/guard-inventory-utils.mjs ./scripts/lib/guard-inventory-utils.mjs",
    );
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
    expect(importGrammarIndex).toBeGreaterThan(-1);
    expect(distImportHelperIndex).toBeGreaterThan(-1);
    expect(packageManifestIndex).toBeGreaterThan(-1);
    expect(extensionManifestIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("for manifest in /tmp/packages/*/package.json");
    expect(dockerfile).toContain(
      'node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS"',
    );
    expect(dockerfile).toContain("done < /tmp/openclaw-workspace-plugin-dirs");
    expect(dockerfile).toContain(`if [ -f "$ext_dir/package.json" ]; then`);
    expect(dockerfile).toContain(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(prepareIndex).toBeLessThan(installIndex);
    expect(importGrammarIndex).toBeLessThan(installIndex);
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
    expect(dockerfile).toContain(
      'selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"',
    );
    expect(dockerfile).toContain('OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)"');
  });

  it.each(["Dockerfile", "scripts/docker/cleanup-smoke/Dockerfile"])(
    "runs root lifecycle scripts from %s dependency inputs",
    async (dockerfileName) => {
      const dockerfile = collapseDockerContinuations(
        await readFile(join(repoRoot, dockerfileName), "utf8"),
      );
      const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
      expect(installIndex).toBeGreaterThan(-1);
      const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-lifecycle-"));
      try {
        // Stage the actual local COPY inputs, not a separately maintained import list.
        // Workspace manifests do not contribute executable root lifecycle modules.
        for (const [, sources, destination] of dockerfile
          .slice(0, installIndex)
          .matchAll(/^COPY ([^\n]+) (\.\/\S*)$/gm)) {
          if (!sources || !destination) {
            throw new Error("Expected local COPY sources and destination");
          }
          if (sources.startsWith("--")) {
            continue;
          }
          for (const input of sources.split(/\s+/)) {
            if (input !== "package.json" && !input.endsWith(".mjs")) {
              continue;
            }
            const target = join(
              fixture,
              destination.endsWith("/") ? join(destination, basename(input)) : destination,
            );
            await mkdir(dirname(target), { recursive: true });
            await cp(join(repoRoot, input), target);
          }
        }
        const packageJson = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        };
        const home = join(fixture, "home");
        await mkdir(home);
        for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
          const command = packageJson.scripts[lifecycle];
          if (!command) {
            continue;
          }
          const scriptPath = command.match(/^node (scripts\/[^\s]+)$/)?.[1];
          if (!scriptPath) {
            throw new Error(`Unsupported root lifecycle command: ${command}`);
          }
          expect
            .soft(
              () =>
                execFileSync(process.execPath, [scriptPath], {
                  cwd: fixture,
                  env: {
                    HOME: home,
                    USERPROFILE: home,
                    PATH: process.env.PATH,
                    npm_config_user_agent: "pnpm/12",
                  },
                  stdio: "pipe",
                }),
              lifecycle,
            )
            .not.toThrow();
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

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

  it.runIf(process.platform !== "win32")(
    "replaces build dependencies with a fresh production tree without losing built assets",
    async () => {
      const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
      const stages = new Map(
        [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)\n([\s\S]*?)(?=^FROM |(?![\s\S]))/gm)].map(
          ([, parent, name, body]) => [name, { parent, body }],
        ),
      );
      const production = stages.get("production-deps");
      expect(production?.parent).toBe("dependency-inputs");
      expect(stages.get("build")?.parent).toBe(production?.parent);
      const inputs = stages.get("dependency-inputs");
      expect(inputs?.parent).toBe("${OPENCLAW_NODE_BOOKWORM_IMAGE}");
      expect(inputs?.body).not.toMatch(/pnpm install|COPY \. \./);
      expect(production?.body).toContain("pnpm install --frozen-lockfile --prod");
      expect(production?.body).not.toMatch(/--ignore-scripts|COPY .*node_modules/);
      expect(dockerfile).not.toContain("pnpm prune");

      const runtime = stages.get("runtime-assets")?.body ?? "";
      const cleanCommand = runtime.match(/^RUN (rm -rf node_modules[^\n]+)/m)?.[1];
      if (!cleanCommand) {
        throw new Error(
          "Runtime assembly must remove build dependency trees before copying production dependencies",
        );
      }
      const productionCopy = "COPY --from=production-deps /app/ ./";
      expect(runtime.indexOf(productionCopy)).toBeGreaterThan(runtime.indexOf(cleanCommand));
      expect(runtime.indexOf("node scripts/prune-docker-plugin-dist.mjs")).toBeGreaterThan(
        runtime.indexOf(productionCopy),
      );

      const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-deps-"));
      try {
        const app = join(fixture, "app");
        const prod = join(fixture, "production");
        const oldFiles = [
          "node_modules/dev-only/index.js",
          "ui/node_modules/dev-only/index.js",
          "packages/ai/node_modules/dev-only/index.js",
          "extensions/selected/node_modules/dev-only/index.js",
        ];
        const builtFiles = [
          "packages/ai/dist/index.mjs",
          "dist/index.js",
          "dist/extensions/node_modules/openclaw/package.json",
          "extensions/selected/index.js",
        ];
        const prodFiles = [
          "node_modules/native-addon/addon.node",
          "node_modules/.modules.yaml",
          "packages/ai/node_modules/runtime-dep/index.js",
          "extensions/selected/node_modules/runtime-dep/index.js",
          "pnpm-lock.yaml",
        ];
        for (const [root, files] of [
          [app, [...oldFiles, ...builtFiles]],
          [prod, prodFiles],
        ] as const) {
          for (const file of files) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), file);
          }
        }
        execFileSync("/bin/sh", ["-eu", "-c", cleanCommand], {
          cwd: app,
          env: { ...process.env, OPENCLAW_BUNDLED_PLUGIN_DIR: "extensions" },
        });
        await mkdir(join(prod, "node_modules/@openclaw"), { recursive: true });
        await symlink("../../packages/ai", join(prod, "node_modules/@openclaw/ai"));
        await cp(prod, app, { recursive: true, verbatimSymlinks: true });
        for (const file of oldFiles) {
          await expect(access(join(app, file))).rejects.toThrow();
        }
        for (const file of [...builtFiles, ...prodFiles]) {
          expect(await readFile(join(app, file), "utf8")).toBe(file);
        }
        expect(await readFile(join(app, "node_modules/@openclaw/ai/dist/index.mjs"), "utf8")).toBe(
          "packages/ai/dist/index.mjs",
        );
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

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
      "COPY --from=runtime-assets --chown=node:node /app/docs ./docs",
      runtimeStageIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    expect(templatesCopyIndex).toBeGreaterThan(runtimeStageIndex);
    expect(templatesCopyIndex).toBeLessThan(userIndex);
  });

  it("keeps package manager metadata in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const installProd = "pnpm install --frozen-lockfile --prod";
    const finalWorkspaceCopy =
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .";

    expect(dockerfile).not.toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).not.toContain("write-runtime-pnpm-workspace");
    expect(dockerfile).not.toContain("pnpm_config_frozen_lockfile=false");
    expect(dockerfile).toContain(finalWorkspaceCopy);
    expect(dockerfile.indexOf(installProd)).toBeGreaterThan(-1);
    expect(dockerfile.indexOf(installProd)).toBeLessThan(dockerfile.indexOf(finalWorkspaceCopy));
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps the release version consistent through build and runtime assembly", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));

    const stampIndex = dockerfile.indexOf('pnpm pkg set "version=$OPENCLAW_DOCKER_BUILD_VERSION"');
    const buildIndex = dockerfile.indexOf("pnpm build:docker");
    const productionDepsIndex = dockerfile.indexOf("COPY --from=production-deps /app/ ./");
    const restoreVersionIndex = dockerfile.indexOf(
      "COPY --from=build /app/package.json ./package.json",
    );
    expect(stampIndex).toBeGreaterThan(dockerfile.indexOf("COPY . ."));
    expect(stampIndex).toBeLessThan(buildIndex);
    expect(restoreVersionIndex).toBeGreaterThan(productionDepsIndex);
    expect(dockerfile).toContain(
      'test "$(node -p "require(\\"/app/package.json\\").version")" = "$OPENCLAW_DOCKER_BUILD_VERSION"',
    );
    expect(dockerfile).toContain(
      'test "$(node -p "require(\\"/app/dist/build-info.json\\").version")" = "$OPENCLAW_DOCKER_BUILD_VERSION"',
    );
    expect(dockerfile).toContain(
      'test "$(node /app/openclaw.mjs --version | cut -d \' \' -f 2)" = "$OPENCLAW_DOCKER_BUILD_VERSION"',
    );
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
    expect(dockerfile).toContain('corepack prepare "$pnpm_spec" --activate');
    expect(dockerfile).toContain('corepack "$pnpm_spec" --version &&');
    expect(dockerfile).toContain("chmod a+r /app/pnpm-lock.yaml");
    expect(dockerfile).not.toContain("(cd /tmp && corepack");
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
