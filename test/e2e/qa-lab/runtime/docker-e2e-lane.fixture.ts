// Shared QA Lab fixture for dispatching existing Docker E2E lanes.
import { spawnSync } from "node:child_process";

type QaDockerE2eLaneDefinition = {
  env?: (env: NodeJS.ProcessEnv) => Record<string, string>;
  script: string;
};

type QaDockerE2eLaneRunResult = {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
};

type SpawnQaDockerE2eLane = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => QaDockerE2eLaneRunResult;

const QA_DOCKER_E2E_LANES = {
  "agent-bundle-mcp-tools": {
    script: "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
  },
  "agents-delete-shared-workspace": {
    script: "scripts/e2e/agents-delete-shared-workspace-docker.sh",
  },
  "bundled-plugin-install-uninstall": {
    script: "scripts/e2e/bundled-plugin-install-uninstall-docker.sh",
  },
  "codex-on-demand": {
    script: "scripts/e2e/codex-on-demand-docker.sh",
  },
  "system-agent-first-run": {
    script: "scripts/e2e/system-agent-first-run-docker.sh",
  },
  "docker-build-image": {
    script: "scripts/e2e/build-image.sh",
  },
  "gateway-network": {
    script: "scripts/e2e/gateway-network-docker.sh",
  },
  "npm-onboard-channel-agent": {
    script: "scripts/e2e/npm-onboard-channel-agent-docker.sh",
  },
  "openai-chat-tools": {
    script: "scripts/e2e/openai-chat-tools-docker.sh",
  },
  "openai-web-search-minimal": {
    script: "scripts/e2e/openai-web-search-minimal-docker.sh",
  },
  openwebui: {
    script: "scripts/e2e/openwebui-docker.sh",
  },
  "plugin-lifecycle-matrix": {
    script: "scripts/e2e/plugin-lifecycle-matrix-docker.sh",
  },
  "release-plugin-marketplace": {
    script: "scripts/e2e/release-plugin-marketplace-docker.sh",
  },
  "release-upgrade-user-journey": {
    script: "scripts/e2e/release-upgrade-user-journey-docker.sh",
  },
  "release-user-journey": {
    script: "scripts/e2e/release-user-journey-docker.sh",
  },
  "update-channel-switch": {
    script: "scripts/e2e/update-channel-switch-docker.sh",
  },
  "update-migration": {
    env: (env) => ({
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:
        env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC ?? "openclaw@2026.4.23",
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO:
        env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO ?? "plugin-deps-cleanup",
    }),
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
  "update-restart-auth": {
    env: (env) => ({
      OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:
        env.OPENCLAW_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT ?? "1500s",
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
    }),
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
  "upgrade-survivor": {
    script: "scripts/e2e/upgrade-survivor-docker.sh",
  },
} satisfies Record<string, QaDockerE2eLaneDefinition>;

type QaDockerE2eLaneName = keyof typeof QA_DOCKER_E2E_LANES;

type QaDockerE2eLaneArgs = { kind: "help" } | { kind: "list" } | { kind: "run"; laneName: string };

type ResolvedQaDockerE2eLane = {
  env: NodeJS.ProcessEnv;
  name: QaDockerE2eLaneName;
  script: string;
};

export function listQaDockerE2eLaneNames(): QaDockerE2eLaneName[] {
  return Object.keys(QA_DOCKER_E2E_LANES).toSorted() as QaDockerE2eLaneName[];
}

export function formatQaDockerE2eLaneUsage(
  entrypoint = "node --import tsx test/e2e/qa-lab/runtime/docker-e2e-lane.ts",
): string {
  return [
    `Usage: ${entrypoint} --lane <name>`,
    "",
    "Known lanes:",
    ...listQaDockerE2eLaneNames().map((lane) => `  - ${lane}`),
    "",
  ].join("\n");
}

export function parseQaDockerE2eLaneArgs(argv: string[]): QaDockerE2eLaneArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  if (argv.includes("--list")) {
    return { kind: "list" };
  }
  const index = argv.indexOf("--lane");
  if (index === -1) {
    throw new Error("--lane is required");
  }
  const laneName = argv[index + 1];
  if (!laneName || laneName.startsWith("-")) {
    throw new Error("--lane requires a value");
  }
  return { kind: "run", laneName };
}

export function resolveQaDockerE2eLane(
  laneName: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedQaDockerE2eLane {
  if (!isQaDockerE2eLaneName(laneName)) {
    throw new Error(`unknown Docker E2E lane: ${laneName}\n\n${formatQaDockerE2eLaneUsage()}`);
  }
  const lane = QA_DOCKER_E2E_LANES[laneName];
  return {
    env: { ...env, ...("env" in lane ? lane.env?.(env) : undefined) },
    name: laneName,
    script: lane.script,
  };
}

export function runQaDockerE2eLane(
  laneName: string,
  deps: {
    env?: NodeJS.ProcessEnv;
    spawn?: SpawnQaDockerE2eLane;
  } = {},
): QaDockerE2eLaneRunResult {
  const lane = resolveQaDockerE2eLane(laneName, deps.env);
  const spawn = deps.spawn ?? spawnSync;
  return spawn("bash", [lane.script], {
    env: lane.env,
    stdio: "inherit",
  });
}

function isQaDockerE2eLaneName(laneName: string): laneName is QaDockerE2eLaneName {
  return Object.hasOwn(QA_DOCKER_E2E_LANES, laneName);
}
