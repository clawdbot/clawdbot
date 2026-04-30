import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mjs";
import privateLocalOnlyPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-private-local-only-subpaths.json" with { type: "json" };
import {
  detectVitestHostInfo as detectVitestHostInfoImpl,
  isCiLikeEnv,
  resolveLocalVitestMaxWorkers as resolveLocalVitestMaxWorkersImpl,
  resolveLocalVitestScheduling as resolveLocalVitestSchedulingImpl,
} from "../../scripts/lib/vitest-local-scheduling.mjs";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { loadVitestExperimentalConfig } from "./vitest.performance-config.ts";
import { shouldPrintVitestThrottle } from "./vitest.system-load.ts";

type VitestHostInfo = {
  cpuCount?: number;
  loadAverage1m?: number;
  totalMemoryBytes?: number;
};

export type OpenClawVitestPool = "forks" | "threads";

export type LocalVitestScheduling = {
  maxWorkers: number;
  fileParallelism: boolean;
  throttledBySystem: boolean;
};

export const jsdomOptimizedDeps = {
  optimizer: {
    web: {
      enabled: true,
      include: ["lit", "lit-html", "@lit/reactive-element", "marked"] as string[],
    },
  },
};

function detectVitestHostInfo(): Required<VitestHostInfo> {
  return detectVitestHostInfoImpl() as Required<VitestHostInfo>;
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
  return resolveLocalVitestSchedulingImpl(env, system, pool) as LocalVitestScheduling;
}

export function resolveDefaultVitestPool(
  _env: Record<string, string | undefined> = process.env,
): OpenClawVitestPool {
  return "threads";
}

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const nonIsolatedRunnerPath = path.join(repoRoot, "test", "non-isolated-runner.ts");
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
  envFile: false,
  resolve: {
    alias: [
      {
        find: "openclaw/extension-api",
        replacement: path.join(repoRoot, "src", "extensionAPI.ts"),
      },
      {
        find: "@openclaw/qa-channel/api.js",
        replacement: path.join(repoRoot, "extensions", "qa-channel", "api.ts"),
      },
      ...sourcePluginSdkSubpaths.map((subpath) => ({
        find: `openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`),
      })),
      ...pluginSdkSubpaths.map((subpath) => ({
        find: `@openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "packages", "plugin-sdk", "src", `${subpath}.ts`),
      })),
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
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
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "test/setup.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      "test/vitest/vitest.channel-paths.mjs",
      "test/vitest/vitest.agents-paths.mjs",
      "test/vitest/vitest.agents-core.config.ts",
      "test/vitest/vitest.agents-pi-embedded.config.ts",
      "test/vitest/vitest.agents-support.config.ts",
      "test/vitest/vitest.agents-tools.config.ts",
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.acp.config.ts",
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.bundled.config.ts",
      "test/vitest/vitest.cli.config.ts",
      "vitest.config.ts",
      "test/vitest/vitest.contracts-shared.ts",
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
      "test/vitest/vitest.contracts-plugin.config.ts",
      "test/vitest/vitest.cron.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.e2e.config.ts",
      "test/vitest/vitest.extension-acpx-paths.mjs",
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-bluebubbles-paths.mjs",
      "test/vitest/vitest.extension-bluebubbles.config.ts",
      "test/vitest/vitest.extension-channel-single-config.ts",
      "test/vitest/vitest.extension-channel-split-paths.mjs",
      "test/vitest/vitest.extension-channels.config.ts",
      "test/vitest/vitest.extension-diffs-paths.mjs",
      "test/vitest/vitest.extension-diffs.config.ts",
      "test/vitest/vitest.extension-discord.config.ts",
      "test/vitest/vitest.extension-feishu-paths.mjs",
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.extension-imessage.config.ts",
      "test/vitest/vitest.extension-irc-paths.mjs",
      "test/vitest/vitest.extension-irc.config.ts",
      "test/vitest/vitest.extension-line.config.ts",
      "test/vitest/vitest.extension-mattermost-paths.mjs",
      "test/vitest/vitest.extension-mattermost.config.ts",
      "test/vitest/vitest.extension-matrix-paths.mjs",
      "test/vitest/vitest.extension-matrix.config.ts",
      "test/vitest/vitest.extension-memory-paths.mjs",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-messaging-paths.mjs",
      "test/vitest/vitest.extension-messaging.config.ts",
      "test/vitest/vitest.extension-msteams-paths.mjs",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.extensions.config.ts",
      "test/vitest/vitest.gateway.config.ts",
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.hooks.config.ts",
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.live.config.ts",
      "test/vitest/vitest.media.config.ts",
      "test/vitest/vitest.media-understanding.config.ts",
      "test/vitest/vitest.performance-config.ts",
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.unit-fast-paths.mjs",
      "test/vitest/vitest.scoped-config.ts",
      "test/vitest/vitest.shared-core.config.ts",
      "test/vitest/vitest.shared.config.ts",
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.tui.config.ts",
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.utils.config.ts",
      "test/vitest/vitest.unit.config.ts",
      "test/vitest/vitest.unit-paths.mjs",
      "test/vitest/vitest.runtime-config.config.ts",
      "test/vitest/vitest.secrets.config.ts",
      "test/vitest/vitest.plugin-sdk.config.ts",
      "test/vitest/vitest.plugins.config.ts",
      "test/vitest/vitest.extension-telegram-paths.mjs",
      "test/vitest/vitest.extension-telegram.config.ts",
      "test/vitest/vitest.extension-voice-call-paths.mjs",
      "test/vitest/vitest.extension-voice-call.config.ts",
      "test/vitest/vitest.extension-whatsapp-paths.mjs",
      "test/vitest/vitest.extension-whatsapp.config.ts",
      "test/vitest/vitest.extension-zalo-paths.mjs",
      "test/vitest/vitest.extension-zalo.config.ts",
      "test/vitest/vitest.extension-provider-paths.mjs",
      "test/vitest/vitest.extension-provider-openai.config.ts",
      "test/vitest/vitest.extension-providers.config.ts",
      "test/vitest/vitest.extension-signal.config.ts",
      "test/vitest/vitest.extension-slack.config.ts",
      "test/vitest/vitest.logging.config.ts",
      "test/vitest/vitest.process.config.ts",
      "test/vitest/vitest.tasks.config.ts",
      "test/vitest/vitest.wizard.config.ts",
    ],
    include: [
      "src/**/*.test.ts",
      BUNDLED_PLUGIN_TEST_GLOB,
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
      "ui/src/ui/app-chat.test.ts",
      "ui/src/ui/chat/**/*.test.ts",
      "ui/src/ui/views/agents-utils.test.ts",
      "ui/src/ui/views/channels.test.ts",
      "ui/src/ui/views/chat.test.ts",
      "ui/src/ui/views/nodes.devices.test.ts",
      "ui/src/ui/views/skills.test.ts",
      "ui/src/ui/views/dreams.test.ts",
      "ui/src/ui/views/usage-render-details.test.ts",
      "ui/src/ui/controllers/agents.test.ts",
      "ui/src/ui/controllers/chat.test.ts",
      "ui/src/ui/controllers/skills.test.ts",
      "ui/src/ui/controllers/sessions.test.ts",
      "ui/src/ui/views/sessions.test.ts",
      "ui/src/ui/app-tool-stream.node.test.ts",
      "ui/src/ui/app-gateway.sessions.node.test.ts",
      "ui/src/ui/chat/slash-command-executor.node.test.ts",
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
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8" as const,
      reporter: ["text", "lcov"],
      all: false,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
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
        "src/agents/pi-embedded-runner.ts",
        "src/agents/sandbox-paths.ts",
        "src/agents/sandbox.ts",
        "src/agents/skills-install.ts",
        "src/agents/pi-tool-definition-adapter.ts",
        "src/agents/tools/discord-actions*.ts",
        "src/agents/tools/slack-actions.ts",
        "src/infra/state-migrations.ts",
        "src/infra/skills-remote.ts",
        "src/infra/update-check.ts",
        "src/infra/ports-inspect.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/memory/batch-gemini.ts",
        "src/gateway/control-ui.ts",
        "src/gateway/server-bridge.ts",
        "src/gateway/server-channels.ts",
        "src/gateway/server-methods/config.ts",
        "src/gateway/server-methods/send.ts",
        "src/gateway/server-methods/skills.ts",
        "src/gateway/server-methods/talk.ts",
        "src/gateway/server-methods/web.ts",
        "src/gateway/server-methods/wizard.ts",
        "src/gateway/call.ts",
        "src/process/tau-rpc.ts",
        "src/process/exec.ts",
        "src/tui/**",
        "src/wizard/**",
        "src/browser/**",
        "src/webchat/**",
        "src/gateway/server.ts",
        "src/gateway/client.ts",
        "src/gateway/protocol/**",
        "src/infra/tailscale.ts",
      ],
    },
    ...loadVitestExperimentalConfig(),
  },
};
