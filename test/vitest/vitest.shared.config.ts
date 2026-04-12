import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mjs";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  BUNDLED_PLUGIN_TEST_GLOB,
} from "./vitest.bundled-plugin-paths.ts";
import { loadVitestExperimentalConfig } from "./vitest.performance-config.ts";
import { shouldPrintVitestThrottle } from "./vitest.system-load.ts";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isSystemThrottleDisabled(env: Record<string, string | undefined>): boolean {
  const normalized = env.OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

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
  return {
    cpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    loadAverage1m: os.loadavg()[0] ?? 0,
    totalMemoryBytes: os.totalmem(),
  };
}

export function resolveLocalVitestMaxWorkers(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = detectVitestHostInfo(),
  pool: OpenClawVitestPool = resolveDefaultVitestPool(env),
): number {
  return resolveLocalVitestScheduling(env, system, pool).maxWorkers;
}

export function resolveLocalVitestScheduling(
  env: Record<string, string | undefined> = process.env,
  system: VitestHostInfo = detectVitestHostInfo(),
  pool: OpenClawVitestPool = resolveDefaultVitestPool(env),
): LocalVitestScheduling {
  const override = parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS ?? env.OPENCLAW_TEST_WORKERS);
  if (override !== null) {
    const maxWorkers = clamp(override, 1, 16);
    return {
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem: false,
    };
  }

  const cpuCount = Math.max(1, system.cpuCount ?? 1);
  const loadAverage1m = Math.max(0, system.loadAverage1m ?? 0);
  const totalMemoryGb = (system.totalMemoryBytes ?? 0) / 1024 ** 3;

  // Keep smaller hosts conservative, but let large local boxes actually use
  // their cores. Thread workers scale much better than the old fork-first cap.
  let inferred =
    cpuCount <= 2
      ? 1
      : cpuCount <= 4
        ? 2
        : cpuCount <= 8
          ? 4
          : Math.max(1, Math.floor(cpuCount * 0.75));

  if (totalMemoryGb <= 16) {
    inferred = Math.min(inferred, 2);
  } else if (totalMemoryGb <= 32) {
    inferred = Math.min(inferred, 4);
  } else if (totalMemoryGb <= 64) {
    inferred = Math.min(inferred, 6);
  } else if (totalMemoryGb <= 128) {
    inferred = Math.min(inferred, 8);
  } else if (totalMemoryGb <= 256) {
    inferred = Math.min(inferred, 12);
  } else {
    inferred = Math.min(inferred, 16);
  }

  const loadRatio = loadAverage1m > 0 ? loadAverage1m / cpuCount : 0;
  if (loadRatio >= 1) {
    inferred = Math.max(1, Math.floor(inferred / 2));
  } else if (loadRatio >= 0.75) {
    inferred = Math.max(1, inferred - 2);
  } else if (loadRatio >= 0.5) {
    inferred = Math.max(1, inferred - 1);
  }

  if (pool === "forks") {
    inferred = Math.min(inferred, 8);
  }

  inferred = clamp(inferred, 1, 16);

  if (isSystemThrottleDisabled(env)) {
    return {
      maxWorkers: inferred,
      fileParallelism: true,
      throttledBySystem: false,
    };
  }

  if (loadRatio >= 1) {
    const maxWorkers = Math.max(1, Math.floor(inferred / 2));
    return {
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem: maxWorkers < inferred,
    };
  }

  if (loadRatio >= 0.75) {
    const maxWorkers = Math.max(2, Math.ceil(inferred * 0.75));
    return {
      maxWorkers,
      fileParallelism: true,
      throttledBySystem: maxWorkers < inferred,
    };
  }

  return {
    maxWorkers: inferred,
    fileParallelism: true,
    throttledBySystem: false,
  };
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
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isWindows = process.platform === "win32";
const defaultPool = resolveDefaultVitestPool();
const localScheduling = resolveLocalVitestScheduling(
  process.env,
  detectVitestHostInfo(),
  defaultPool,
);
const ciWorkers = isWindows ? 2 : 3;

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
      ...pluginSdkSubpaths.map((subpath) => ({
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
    maxWorkers: isCI ? ciWorkers : localScheduling.maxWorkers,
    fileParallelism: isCI ? true : localScheduling.fileParallelism,
    forceRerunTriggers: [
      "package.json",
      "pnpm-lock.yaml",
      "test/setup.ts",
      "test/setup.shared.ts",
      "test/setup.extensions.ts",
      "test/setup-openclaw-runtime.ts",
      "test/vitest/vitest.channel-paths.mjs",
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.acp.config.ts",
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.bundled.config.ts",
      "test/vitest/vitest.cli.config.ts",
      "vitest.config.ts",
      "test/vitest/vitest.contracts.config.ts",
      "test/vitest/vitest.cron.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.e2e.config.ts",
      "test/vitest/vitest.extension-acpx-paths.mjs",
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-bluebubbles-paths.mjs",
      "test/vitest/vitest.extension-bluebubbles.config.ts",
      "test/vitest/vitest.extension-channels.config.ts",
      "test/vitest/vitest.extension-diffs-paths.mjs",
      "test/vitest/vitest.extension-diffs.config.ts",
      "test/vitest/vitest.extension-feishu-paths.mjs",
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.extension-irc-paths.mjs",
      "test/vitest/vitest.extension-irc.config.ts",
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
      "test/vitest/vitest.extension-providers.config.ts",
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
      include: ["./src/**/*.ts"],
      exclude: [
        `${BUNDLED_PLUGIN_ROOT_DIR}/**`,
        "apps/**",
        "ui/**",
        "test/**",
        "src/**/*.test.ts",
        "src/entry.ts",
        "src/index.ts",
        "src/runtime.ts",
        "src/channel-web.ts",
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
        "src/channels/web/**",
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
