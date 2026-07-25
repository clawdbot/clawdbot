// Vitest shared config wires the shared test shard.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import acpCorePackageJson from "../../packages/acp-core/package.json" with { type: "json" };
import { pluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mjs";
import privateLocalOnlyPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-private-local-only-subpaths.json" with { type: "json" };
import {
  detectVitestHostInfo as detectVitestHostInfoImpl,
  isCiLikeEnv,
  resolveLocalVitestMaxWorkers as resolveLocalVitestMaxWorkersImpl,
  resolveLocalVitestScheduling as resolveLocalVitestSchedulingImpl,
} from "../../scripts/lib/vitest-local-scheduling.mjs";
import type {
  LocalVitestScheduling,
  VitestHostInfo,
} from "../../scripts/lib/vitest-local-scheduling.mjs";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { loadVitestExperimentalConfig } from "./vitest.performance-config.ts";
import { shouldPrintVitestThrottle } from "./vitest.system-load.ts";

export type OpenClawVitestPool = "forks" | "threads";

export type { LocalVitestScheduling };

export const jsdomOptimizedDeps = {
  optimizer: {
    web: {
      enabled: true,
      include: ["lit", "lit-html", "@lit/reactive-element", "marked"] as string[],
    },
  },
};

function detectVitestHostInfo(): Required<VitestHostInfo> {
  return detectVitestHostInfoImpl();
}

export function resolveLocalVitestMaxWorkers(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = detectVitestHostInfo(),
  pool: OpenClawVitestPool = resolveDefaultVitestPool(env),
): number {
  return resolveLocalVitestMaxWorkersImpl(env, system, pool);
}

export function resolveLocalVitestScheduling(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = detectVitestHostInfo(),
  pool: OpenClawVitestPool = resolveDefaultVitestPool(env),
): LocalVitestScheduling {
  return resolveLocalVitestSchedulingImpl(env, system, pool);
}

export function resolveDefaultVitestPool(
  _env: Record<string, string | undefined> = process.env,
): OpenClawVitestPool {
  return "threads";
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const nonIsolatedRunnerPath = path.join(repoRoot, "test", "non-isolated-runner.ts");
const vitestConfigFiles = fs
  .readdirSync(path.join(repoRoot, "test", "vitest"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:mjs|ts)$/u.test(entry.name))
  .map((entry) => `test/vitest/${entry.name}`)
  .toSorted((left, right) => left.localeCompare(right));
export function resolveRepoRootPath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}
const isCI = isCiLikeEnv(process.env);
const isWindows = process.platform === "win32";
const defaultPool = resolveDefaultVitestPool();
const localScheduling = resolveLocalVitestScheduling(
  process.env,
  detectVitestHostInfo(),
  defaultPool,
);

function hasWorkerOverride(env: Record<string, string | undefined>): boolean {
  return Boolean((env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS)?.trim());
}

function sourcePackageAlias(packageId: string, subpath?: string) {
  return {
    find: `@openclaw/${packageId}${subpath ? `/${subpath}` : ""}`,
    replacement: path.join(
      repoRoot,
      "packages",
      packageId,
      "src",
      ...(subpath ? subpath.split("/") : ["index"]).map((part, index, parts) =>
        index === parts.length - 1 ? `${part}.ts` : part,
      ),
    ),
  };
}

function sourcePackageAliasesFromExports(packageId: string, exports: Record<string, unknown>) {
  return Object.keys(exports)
    .map((exportKey) => (exportKey === "." ? undefined : exportKey.slice(2)))
    .filter((subpath) => subpath === undefined || (subpath && !subpath.includes("..")))
    .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))
    .map((subpath) => sourcePackageAlias(packageId, subpath));
}

export function resolveSharedVitestWorkerConfig(params: {
  env?: Record<string, string | undefined>;
  isCI?: boolean;
  isWindows?: boolean;
  localScheduling?: LocalVitestScheduling;
}): Pick<LocalVitestScheduling, "fileParallelism" | "maxWorkers"> {
  const env = params.env ?? process.env;
  const local = params.localScheduling ?? localScheduling;
  if (hasWorkerOverride(env)) {
    return {
      fileParallelism: local.fileParallelism,
      maxWorkers: local.maxWorkers,
    };
  }
  if (params.isCI ?? isCI) {
    return {
      fileParallelism: true,
      maxWorkers: (params.isWindows ?? isWindows) ? 2 : 3,
    };
  }
  return {
    fileParallelism: local.fileParallelism,
    maxWorkers: local.maxWorkers,
  };
}

const workerConfig = resolveSharedVitestWorkerConfig({
  env: process.env,
  isCI,
  isWindows,
  localScheduling,
});
const dependencyModuleDirectories = ["/node_modules/", "/openclaw-pnpm-node-modules/"];
const dependencyExternalPatterns = [
  /\/openclaw-pnpm-node-modules\/(?!.*\/?vite\w*\/dist\/client\/env\.mjs$).*\.(?:cjs\.js|mjs)$/u,
];
const sourcePluginSdkSubpaths = [
  ...new Set([...pluginSdkSubpaths, ...privateLocalOnlyPluginSdkSubpaths]),
].toSorted((left, right) => left.localeCompare(right));

if (!isCI && localScheduling.throttledBySystem && shouldPrintVitestThrottle(process.env)) {
  console.error(
    `[vitest] throttling local workers to ${localScheduling.maxWorkers}${
      localScheduling.fileParallelism ? "" : " with file parallelism disabled"
    } because the host already looks busy.`,
  );
}

export const sharedVitestConfig = {
  root: repoRoot,
  envDir: false as const,
  resolve: {
    alias: [
      {
        find: "discord-api-types/v10",
        replacement: path.join(repoRoot, "test", "vitest", "discord-api-types-v10-runtime.ts"),
      },
      {
        find: "discord-api-types/payloads/v10",
        replacement: path.join(
          repoRoot,
          "test",
          "vitest",
          "discord-api-types-payloads-v10-runtime.ts",
        ),
      },
      {
        find: "@openclaw/qa-channel/api.js",
        replacement: path.join(repoRoot, "extensions", "qa-channel", "api.ts"),
      },
      {
        find: "@openclaw/discord/api.js",
        replacement: path.join(repoRoot, "extensions", "discord", "api.ts"),
      },
      {
        find: "@openclaw/matrix/test-api.js",
        replacement: path.join(repoRoot, "extensions", "matrix", "test-api.ts"),
      },
      {
        find: "@openclaw/slack/api.js",
        replacement: path.join(repoRoot, "extensions", "slack", "api.ts"),
      },
      {
        find: "@openclaw/whatsapp/api.js",
        replacement: path.join(repoRoot, "extensions", "whatsapp", "api.ts"),
      },
      {
        find: "@openclaw/gateway-client/browser",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "browser.ts"),
      },
      {
        find: "@openclaw/gateway-client/readiness",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "readiness.ts"),
      },
      {
        find: "@openclaw/gateway-client/timeouts",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "timeouts.ts"),
      },
      {
        find: "@openclaw/gateway-client",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "index.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/client-info",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "client-info.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/connect-error-details",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "connect-error-details.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/frame-guards",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "frame-guards.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/gateway-error-details",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "gateway-error-details.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/schema",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "schema.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/startup-unavailable",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "startup-unavailable.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/version",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "version.ts"),
      },
      {
        find: "@openclaw/gateway-protocol",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "index.ts"),
      },
      {
        find: /^@openclaw\/ai\/internal\/(.+)$/,
        replacement: path.join(repoRoot, "packages", "ai", "src", "internal", "$1.ts"),
      },
      {
        find: "@openclaw/ai/diagnostics",
        replacement: path.join(repoRoot, "packages", "ai", "src", "utils", "diagnostics.ts"),
      },
      {
        find: "@openclaw/ai/event-stream",
        replacement: path.join(repoRoot, "packages", "ai", "src", "utils", "event-stream.ts"),
      },
      {
        find: "@openclaw/ai/providers",
        replacement: path.join(repoRoot, "packages", "ai", "src", "providers.ts"),
      },
      {
        find: "@openclaw/ai/types",
        replacement: path.join(repoRoot, "packages", "ai", "src", "types.ts"),
      },
      {
        find: "@openclaw/ai/validation",
        replacement: path.join(repoRoot, "packages", "ai", "src", "validation.ts"),
      },
      {
        find: /^@openclaw\/ai\/(.+)$/,
        replacement: path.join(repoRoot, "packages", "ai", "src", "$1.ts"),
      },
      {
        find: "@openclaw/ai",
        replacement: path.join(repoRoot, "packages", "ai", "src", "index.ts"),
      },
      {
        find: "@openclaw/llm-core/diagnostics",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "utils", "diagnostics.ts"),
      },
      {
        find: "@openclaw/llm-core/event-stream",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "utils", "event-stream.ts"),
      },
      {
        find: "@openclaw/llm-core/validation",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "validation.ts"),
      },
      {
        find: "@openclaw/llm-core",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "index.ts"),
      },
      {
        find: "@openclaw/model-catalog-core/configured-model-refs",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "configured-model-refs.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/model-catalog-refs",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-refs.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/model-catalog-normalize",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-normalize.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/model-catalog-types",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-types.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/provider-id",
        replacement: path.join(repoRoot, "packages", "model-catalog-core", "src", "provider-id.ts"),
      },
      {
        find: "@openclaw/model-catalog-core/provider-model-id-normalization",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "provider-model-id-normalization.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/provider-model-id-normalize",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "provider-model-id-normalize.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core",
        replacement: path.join(repoRoot, "packages", "model-catalog-core", "src", "index.ts"),
      },
      {
        find: "@openclaw/net-policy/ip",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "ip.ts"),
      },
      {
        find: "@openclaw/net-policy/ipv4",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "ipv4.ts"),
      },
      {
        find: "@openclaw/net-policy/redact-sensitive-url",
        replacement: path.join(
          repoRoot,
          "packages",
          "net-policy",
          "src",
          "redact-sensitive-url.ts",
        ),
      },
      {
        find: "@openclaw/net-policy/url-protocol",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "url-protocol.ts"),
      },
      {
        find: "@openclaw/net-policy/url-userinfo",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "url-userinfo.ts"),
      },
      {
        find: "@openclaw/net-policy",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "index.ts"),
      },
      {
        find: "@openclaw/normalization-core/agent-id",
        replacement: path.join(repoRoot, "packages", "normalization-core", "src", "agent-id.ts"),
      },
      {
        find: "@openclaw/normalization-core/boolean-coercion",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "boolean-coercion.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/error-coercion",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "error-coercion.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/number-coercion",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "number-coercion.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/phone-presentation",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "phone-presentation.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/record-coerce",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "record-coerce.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/result",
        replacement: path.join(repoRoot, "packages", "normalization-core", "src", "result.ts"),
      },
      {
        find: "@openclaw/normalization-core/string-coerce",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "string-coerce.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/string-normalization",
        replacement: path.join(
          repoRoot,
          "packages",
          "normalization-core",
          "src",
          "string-normalization.ts",
        ),
      },
      {
        find: "@openclaw/normalization-core/utf16-slice",
        replacement: path.join(repoRoot, "packages", "normalization-core", "src", "utf16-slice.ts"),
      },
      {
        find: /^@openclaw\/normalization-core$/u,
        replacement: path.join(repoRoot, "packages", "normalization-core", "src", "index.ts"),
      },
      sourcePackageAlias("markdown-core", "code-spans"),
      sourcePackageAlias("markdown-core", "fences"),
      sourcePackageAlias("media-core", "base64"),
      sourcePackageAlias("media-core", "constants"),
      sourcePackageAlias("media-core", "content-length"),
      sourcePackageAlias("media-core", "file-name"),
      sourcePackageAlias("media-core", "inbound-path-policy"),
      sourcePackageAlias("media-core", "inline-image-data-url"),
      sourcePackageAlias("media-core", "media-source-url"),
      sourcePackageAlias("media-core", "mime"),
      sourcePackageAlias("media-core", "read-byte-stream-with-limit"),
      sourcePackageAlias("media-core"),
      sourcePackageAlias("retry"),
      sourcePackageAlias("workboard-contract"),
      ...sourcePackageAliasesFromExports("acp-core", acpCorePackageJson.exports),
      ...sourcePluginSdkSubpaths.map((subpath) => ({
        find: `openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`),
      })),
      ...pluginSdkSubpaths.map((subpath) => ({
        find: `@openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "packages", "plugin-sdk", "src", `${subpath}.ts`),
      })),
    ],
  },
  test: {
    dir: repoRoot,
    testTimeout: 120_000,
    hookTimeout: isWindows ? 180_000 : 120_000,
    unstubEnvs: true,
    unstubGlobals: true,
    isolate: false,
    pool: defaultPool,
    runner: nonIsolatedRunnerPath,
    maxWorkers: workerConfig.maxWorkers,
    fileParallelism: workerConfig.fileParallelism,
    deps: {
      moduleDirectories: dependencyModuleDirectories,
    },
    server: {
      deps: {
        external: dependencyExternalPatterns,
      },
    },
    // Vitest matches these with picomatch against absolute changed-file paths, so every entry
    // must resolve absolute; relative entries silently never match. Explicit lane files keep
    // watcher registration working (chokidar v4+ ignores globs in watcher.add) while the glob
    // keeps match coverage for files added after config load.
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "vitest.config.ts",
      "test/setup.ts",
      "test/setup.env.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      ...vitestConfigFiles,
      "test/vitest/**/*.{ts,mjs}",
    ].map(resolveRepoRootPath),
    include: [
      "src/**/*.test.ts",
      BUNDLED_PLUGIN_TEST_GLOB,
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
      "ui/src/pages/chat/tool-stream.node.test.ts",
    ],
    setupFiles: [resolveRepoRootPath("test/setup.ts")],
    exclude: [
      "dist/**",
      "test/fixtures/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/OpenClaw.app/**",
      "**/._*",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov"],
      all: false,
      exclude: [
        `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
        "apps/**",
        "ui/**",
        "test/**",
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/logging.ts",
        "src/cli/**",
        "src/commands/**",
        "src/daemon/**",
        "src/hooks/**",
        "src/macos/**",
        "src/acp/**",
        "src/agents/**",
        "src/channels/**",
        "src/gateway/**",
        "src/line/**",
        "src/media-understanding/**",
        "src/node-host/**",
        "src/plugins/**",
        "src/providers/**",
        "src/secrets/**",
        "src/agents/model-scan.ts",
        "src/agents/embedded-agent-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/agent-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/infra/state-migrations.ts",
        "src/infra/update-check.ts",
        "src/infra/ports-inspect.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/gateway/control-ui.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/server-methods/talk.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",
        "src/gateway/call.ts",
        "src/process/exec.ts",
        "src/tui/**",
        "src/wizard/**",
        "src/browser/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "packages/gateway-protocol/src/**",
        "src/infra/tailscale.ts",
      ],
    },
    ...loadVitestExperimentalConfig(),
  },
};
