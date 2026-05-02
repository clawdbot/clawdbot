// Docker E2E scenario catalog.
// Keep lane names, commands, image kind, timeout, resources, and release chunks
// here. Planning and execution live in separate modules.

export const DEFAULT_LIVE_RETRIES = 1;
const LIVE_ACP_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_PROFILE_TIMEOUT_MS = 20 * 60 * 1000;
const OPENWEBUI_TIMEOUT_MS = 20 * 60 * 1000;
export const BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS = 24;
const upgradeSurvivorCommand = "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:upgrade-survivor";

const LIVE_RETRY_PATTERNS = [
  /529\b/i,
  /overloaded/i,
  /capacity/i,
  /rate.?limit/i,
  /gateway closed \(1000 normal closure\)/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
];

function liveDockerScriptCommand(script, envPrefix = "") {
  const prefix = envPrefix ? `${envPrefix} ` : "";
  return `${prefix}OPENCLAW_SKIP_DOCKER_BUILD=1 bash -c 'harness="\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-}"; if [ -z "$harness" ]; then if [ -d .release-harness/scripts ]; then harness=.release-harness; else harness=.; fi; fi; OPENCLAW_LIVE_DOCKER_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" bash "$harness/scripts/${script}"'`;
}

function lane(name, command, options = {}) {
  return {
    cacheKey: options.cacheKey,
    command,
    e2eImageKind:
      options.e2eImageKind === false
        ? undefined
        : (options.e2eImageKind ?? (options.live ? undefined : "functional")),
    estimateSeconds: options.estimateSeconds,
    live: options.live === true,
    noOutputTimeoutMs: options.noOutputTimeoutMs,
    name,
    retryPatterns: options.retryPatterns ?? [],
    retries: options.retries ?? 0,
    resources: options.resources ?? [],
    stateScenario: options.stateScenario,
    timeoutMs: options.timeoutMs,
    weight: options.weight ?? 1,
  };
}

function liveProviderResource(provider) {
  if (!provider) {
    return undefined;
  }
  if (provider === "claude-cli" || provider === "claude") {
    return "live:claude";
  }
  if (provider === "codex-cli" || provider === "codex") {
    return "live:codex";
  }
  if (provider === "droid") {
    return "live:droid";
  }
  if (provider === "google-gemini-cli" || provider === "gemini") {
    return "live:gemini";
  }
  if (provider === "opencode") {
    return "live:opencode";
  }
  if (provider === "openai") {
    return "live:openai";
  }
  return `live:${provider}`;
}

function liveProviderResources(options) {
  const providers = options.providers ?? (options.provider ? [options.provider] : []);
  return providers.map(liveProviderResource).filter(Boolean);
}

function liveLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    live: true,
    resources: ["live", ...liveProviderResources(options), ...(options.resources ?? [])],
    retryPatterns: options.retryPatterns ?? LIVE_RETRY_PATTERNS,
    retries: options.retries ?? DEFAULT_LIVE_RETRIES,
    weight: options.weight ?? 3,
  });
}

function npmLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    e2eImageKind: options.e2eImageKind ?? "bare",
    resources: ["npm", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

function serviceLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    resources: ["service", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

const bundledPluginInstallUninstallLanes = Array.from(
  { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
  (_, index) =>
    lane(
      `bundled-plugin-install-uninstall-${index}`,
      `OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL=${BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS} OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX=${index} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-plugin-install-uninstall`,
      {
        estimateSeconds: 120,
        resources: ["npm"],
        stateScenario: "empty",
        weight: 1,
      },
    ),
);

export const mainLanes = [
  liveLane("live-models", liveDockerScriptCommand("test-live-models-docker.sh"), {
    providers: ["claude-cli", "codex-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane("live-gateway", liveDockerScriptCommand("test-live-gateway-models-docker.sh"), {
    providers: ["claude-cli", "codex-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane(
    "live-cli-backend-claude",
    liveDockerScriptCommand(
      "test-live-cli-backend-docker.sh",
      "OPENCLAW_LIVE_CLI_BACKEND_MODEL=claude-cli/claude-sonnet-4-6",
    ),
    {
      cacheKey: "cli-backend-claude",
      provider: "claude-cli",
      resources: ["npm"],
      timeoutMs: LIVE_CLI_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-cli-backend-gemini",
    liveDockerScriptCommand(
      "test-live-cli-backend-docker.sh",
      "OPENCLAW_LIVE_CLI_BACKEND_MODEL=google-gemini-cli/gemini-3-flash-preview",
    ),
    {
      cacheKey: "cli-backend-gemini",
      provider: "google-gemini-cli",
      resources: ["npm"],
      timeoutMs: LIVE_CLI_TIMEOUT_MS,
      weight: 3,
    },
  ),
  serviceLane("openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui", {
    timeoutMs: OPENWEBUI_TIMEOUT_MS,
    weight: 5,
  }),
  serviceLane("onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard", {
    stateScenario: "empty",
    weight: 2,
  }),
  npmLane(
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
    { resources: ["service"], stateScenario: "empty", weight: 3 },
  ),
  serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
  serviceLane(
    "agents-delete-shared-workspace",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:agents-delete-shared-workspace",
    { stateScenario: "empty" },
  ),
  serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  lane("pi-bundle-mcp-tools", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools", {
    stateScenario: "empty",
  }),
  lane("crestodian-rescue", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-rescue", {
    stateScenario: "empty",
  }),
  lane("crestodian-planner", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-planner", {
    stateScenario: "empty",
  }),
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    { resources: ["npm"], stateScenario: "empty", weight: 3 },
  ),
  npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
    stateScenario: "empty",
    weight: 3,
  }),
  npmLane(
    "update-channel-switch",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-channel-switch",
    {
      stateScenario: "update-stable",
      timeoutMs: 30 * 60 * 1000,
      weight: 3,
    },
  ),
  npmLane("upgrade-survivor", upgradeSurvivorCommand, {
    stateScenario: "upgrade-survivor",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  npmLane(
    "published-upgrade-survivor",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:published-upgrade-survivor",
    {
      stateScenario: "upgrade-survivor",
      timeoutMs: 25 * 60 * 1000,
      weight: 3,
    },
  ),
  npmLane("update-migration", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-migration", {
    stateScenario: "upgrade-survivor",
    timeoutMs: 30 * 60 * 1000,
    weight: 3,
  }),
  lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    weight: 6,
  }),
  lane("kitchen-sink-plugin", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-plugin", {
    resources: ["npm"],
    stateScenario: "empty",
    weight: 3,
  }),
  ...bundledPluginInstallUninstallLanes,
  lane(
    "plugins-offline",
    "OPENCLAW_PLUGINS_E2E_CLAWHUB=0 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
    {
      resources: ["npm", "service"],
      stateScenario: "empty",
      weight: 6,
    },
  ),
  npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update", {
    stateScenario: "empty",
  }),
  serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload", {
    stateScenario: "empty",
  }),
  lane("openai-image-auth", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-image-auth", {
    stateScenario: "empty",
  }),
  lane(
    "crestodian-first-run",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-first-run",
    { stateScenario: "empty" },
  ),
  lane(
    "session-runtime-context",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:session-runtime-context",
  ),
  lane("commitments-safety", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:commitments-safety", {
    stateScenario: "empty",
  }),
  lane("qr", "pnpm test:docker:qr"),
];

export const tailLanes = [
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
    { stateScenario: "empty", timeoutMs: 8 * 60 * 1000 },
  ),
  liveLane("live-codex-harness", liveDockerScriptCommand("test-live-codex-harness-docker.sh"), {
    cacheKey: "codex-harness",
    provider: "codex-cli",
    resources: ["npm"],
    timeoutMs: LIVE_ACP_TIMEOUT_MS,
    weight: 3,
  }),
  liveLane(
    "live-codex-bind",
    liveDockerScriptCommand(
      "test-live-codex-harness-docker.sh",
      "OPENCLAW_LIVE_CODEX_BIND=1 OPENCLAW_LIVE_CODEX_TEST_FILES=src/gateway/gateway-codex-bind.live.test.ts",
    ),
    {
      cacheKey: "codex-harness",
      provider: "codex-cli",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-cli-backend-codex",
    liveDockerScriptCommand(
      "test-live-cli-backend-docker.sh",
      "OPENCLAW_LIVE_CLI_BACKEND_MODEL=codex-cli/gpt-5.5",
    ),
    {
      cacheKey: "cli-backend-codex",
      provider: "codex-cli",
      resources: ["npm"],
      timeoutMs: LIVE_CLI_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-acp-bind-claude",
    liveDockerScriptCommand("test-live-acp-bind-docker.sh", "OPENCLAW_LIVE_ACP_BIND_AGENT=claude"),
    {
      cacheKey: "acp-bind-claude",
      provider: "claude-cli",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-acp-bind-codex",
    liveDockerScriptCommand("test-live-acp-bind-docker.sh", "OPENCLAW_LIVE_ACP_BIND_AGENT=codex"),
    {
      cacheKey: "acp-bind-codex",
      provider: "codex-cli",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-acp-bind-droid",
    liveDockerScriptCommand(
      "test-live-acp-bind-docker.sh",
      "OPENCLAW_LIVE_ACP_BIND_AGENT=droid OPENCLAW_LIVE_ACP_BIND_REQUIRE_TRANSCRIPT=1",
    ),
    {
      cacheKey: "acp-bind-droid",
      provider: "droid",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-acp-bind-gemini",
    liveDockerScriptCommand("test-live-acp-bind-docker.sh", "OPENCLAW_LIVE_ACP_BIND_AGENT=gemini"),
    {
      cacheKey: "acp-bind-gemini",
      provider: "google-gemini-cli",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane(
    "live-acp-bind-opencode",
    liveDockerScriptCommand(
      "test-live-acp-bind-docker.sh",
      "OPENCLAW_LIVE_ACP_BIND_AGENT=opencode OPENCLAW_LIVE_ACP_BIND_REQUIRE_TRANSCRIPT=1",
    ),
    {
      cacheKey: "acp-bind-opencode",
      provider: "opencode",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
];

const releasePathPluginRuntimeLanes = [
  lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    weight: 6,
  }),
  ...bundledPluginInstallUninstallLanes,
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    {
      resources: ["npm"],
      stateScenario: "empty",
      weight: 3,
    },
  ),
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
    { stateScenario: "empty", timeoutMs: 8 * 60 * 1000 },
  ),
];

const releasePathPluginRuntimePluginLanes = [
  lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
    resources: ["npm", "service"],
    stateScenario: "empty",
    weight: 6,
  }),
];

const releasePathPluginRuntimeServiceLanes = [
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    {
      resources: ["npm"],
      stateScenario: "empty",
      weight: 3,
    },
  ),
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
    { stateScenario: "empty", timeoutMs: 8 * 60 * 1000 },
  ),
];

const releasePathPluginRuntimeCoreLanes = [
  ...releasePathPluginRuntimePluginLanes,
  ...releasePathPluginRuntimeServiceLanes,
];

const releasePathBundledChannelLanes = [
  npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update", {
    stateScenario: "empty",
  }),
];

const releasePathPackageInstallOpenAiLanes = [
  npmLane(
    "install-e2e-openai",
    "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=openai OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-openai:local pnpm test:install:e2e",
    {
      resources: ["service"],
      weight: 3,
    },
  ),
];

const releasePathPackageInstallAnthropicLanes = [
  npmLane(
    "install-e2e-anthropic",
    "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=anthropic OPENCLAW_INSTALL_E2E_IMAGE=openclaw-install-e2e-anthropic:local pnpm test:install:e2e",
    {
      resources: ["service"],
      weight: 3,
    },
  ),
];

const releasePathPackageUpdateCoreLanes = [
  npmLane(
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
    { resources: ["service"], stateScenario: "empty", weight: 3 },
  ),
  npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
    stateScenario: "empty",
    weight: 3,
  }),
  npmLane(
    "update-channel-switch",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-channel-switch",
    {
      stateScenario: "update-stable",
      timeoutMs: 30 * 60 * 1000,
      weight: 3,
    },
  ),
  npmLane("upgrade-survivor", upgradeSurvivorCommand, {
    stateScenario: "upgrade-survivor",
    timeoutMs: 20 * 60 * 1000,
    weight: 3,
  }),
  npmLane(
    "published-upgrade-survivor",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:published-upgrade-survivor",
    {
      stateScenario: "upgrade-survivor",
      timeoutMs: 25 * 60 * 1000,
      weight: 3,
    },
  ),
];

const primaryReleasePathChunks = {
  core: [
    lane("qr", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:qr"),
    serviceLane("onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard", {
      stateScenario: "empty",
      weight: 2,
    }),
    serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
    serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload", {
      stateScenario: "empty",
    }),
    lane(
      "session-runtime-context",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:session-runtime-context",
    ),
    lane("commitments-safety", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:commitments-safety", {
      stateScenario: "empty",
    }),
    lane(
      "pi-bundle-mcp-tools",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools",
      { stateScenario: "empty" },
    ),
    serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
      resources: ["npm"],
      stateScenario: "empty",
      weight: 3,
    }),
  ],
  "package-update-openai": releasePathPackageInstallOpenAiLanes,
  "package-update-anthropic": releasePathPackageInstallAnthropicLanes,
  "package-update-core": releasePathPackageUpdateCoreLanes,
  "plugins-runtime-plugins": releasePathPluginRuntimePluginLanes,
  "plugins-runtime-services": releasePathPluginRuntimeServiceLanes,
  "plugins-runtime-install-a": bundledPluginInstallUninstallLanes.slice(0, 3),
  "plugins-runtime-install-b": bundledPluginInstallUninstallLanes.slice(3, 6),
  "plugins-runtime-install-c": bundledPluginInstallUninstallLanes.slice(6, 9),
  "plugins-runtime-install-d": bundledPluginInstallUninstallLanes.slice(9, 12),
  "plugins-runtime-install-e": bundledPluginInstallUninstallLanes.slice(12, 15),
  "plugins-runtime-install-f": bundledPluginInstallUninstallLanes.slice(15, 18),
  "plugins-runtime-install-g": bundledPluginInstallUninstallLanes.slice(18, 21),
  "plugins-runtime-install-h": bundledPluginInstallUninstallLanes.slice(21),
  openwebui: [],
};

const legacyReleasePathChunks = {
  "package-update": [
    ...releasePathPackageInstallOpenAiLanes,
    ...releasePathPackageInstallAnthropicLanes,
    ...releasePathPackageUpdateCoreLanes,
  ],
  "plugins-runtime-core": releasePathPluginRuntimeCoreLanes,
  "plugins-runtime": releasePathPluginRuntimeLanes,
  "plugins-integrations": [...releasePathPluginRuntimeLanes, ...releasePathBundledChannelLanes],
  "bundled-channels": releasePathBundledChannelLanes,
};

function openWebUILane() {
  return serviceLane("openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui", {
    timeoutMs: OPENWEBUI_TIMEOUT_MS,
    weight: 5,
  });
}

export function releasePathChunkLanes(chunk, options = {}) {
  const base = primaryReleasePathChunks[chunk] ?? legacyReleasePathChunks[chunk];
  if (!base) {
    throw new Error(
      `OPENCLAW_DOCKER_ALL_CHUNK must be one of: ${[
        ...Object.keys(primaryReleasePathChunks),
        ...Object.keys(legacyReleasePathChunks),
      ].join(", ")}. Got: ${JSON.stringify(chunk)}`,
    );
  }
  if (chunk === "openwebui") {
    return options.includeOpenWebUI ? [openWebUILane()] : [];
  }
  if (
    (chunk !== "plugins-runtime-services" &&
      chunk !== "plugins-runtime-core" &&
      chunk !== "plugins-runtime" &&
      chunk !== "plugins-integrations") ||
    !options.includeOpenWebUI
  ) {
    return base;
  }
  return [...base, openWebUILane()];
}

export function allReleasePathLanes(options = {}) {
  return Object.keys(primaryReleasePathChunks)
    .filter((chunk) => chunk !== "openwebui")
    .flatMap((chunk) =>
      releasePathChunkLanes(chunk, {
        includeOpenWebUI: options.includeOpenWebUI,
      }),
    );
}
