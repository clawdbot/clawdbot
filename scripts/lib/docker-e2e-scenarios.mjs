// Docker E2E scenario catalog.
// Keep lane names, commands, image kind, timeout, resources, and release chunks
// here. Planning and execution live in separate modules.

const BUNDLED_UPDATE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_LIVE_RETRIES = 1;
const LIVE_ACP_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_PROFILE_TIMEOUT_MS = 20 * 60 * 1000;
const OPENWEBUI_TIMEOUT_MS = 20 * 60 * 1000;

export const LIVE_RETRY_PATTERNS = [
  /529\b/i,
  /overloaded/i,
  /capacity/i,
  /rate.?limit/i,
  /gateway closed \(1000 normal closure\)/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
];

const bundledChannelLaneCommand =
  "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps";

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
    name,
    retryPatterns: options.retryPatterns ?? [],
    retries: options.retries ?? 0,
    resources: options.resources ?? [],
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

function bundledChannelScenarioLane(name, env, options = {}) {
  return npmLane(
    name,
    `${env} OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-channel-deps`,
    options,
  );
}

const bundledScenarioLanes = [
  ...["telegram", "discord", "slack", "feishu", "memory-lancedb"].map((channel) =>
    npmLane(
      `bundled-channel-${channel}`,
      `OPENCLAW_BUNDLED_CHANNELS=${channel} ${bundledChannelLaneCommand}`,
    ),
  ),
  ...["telegram", "discord", "slack", "feishu", "memory-lancedb", "acpx"].map((target) =>
    bundledChannelScenarioLane(
      `bundled-channel-update-${target}`,
      `OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=${target} OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0`,
      { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
    ),
  ),
  bundledChannelScenarioLane(
    "bundled-channel-root-owned",
    "OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0",
  ),
  bundledChannelScenarioLane(
    "bundled-channel-setup-entry",
    "OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0",
  ),
  bundledChannelScenarioLane(
    "bundled-channel-load-failure",
    "OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0",
  ),
  bundledChannelScenarioLane(
    "bundled-channel-disabled-config",
    "OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=1",
  ),
];

export const mainLanes = [
  liveLane("live-models", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-models", {
    providers: ["claude-cli", "codex-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane("live-gateway", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-gateway", {
    providers: ["claude-cli", "codex-cli", "google-gemini-cli"],
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane(
    "live-cli-backend-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:claude",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:gemini",
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
    weight: 2,
  }),
  npmLane(
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
    { resources: ["service"], weight: 3 },
  ),
  serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
  serviceLane(
    "agents-delete-shared-workspace",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:agents-delete-shared-workspace",
  ),
  serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
    resources: ["npm"],
    weight: 3,
  }),
  lane("pi-bundle-mcp-tools", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools"),
  lane("crestodian-rescue", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-rescue"),
  lane("crestodian-planner", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-planner"),
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    { resources: ["npm"], weight: 3 },
  ),
  npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
    weight: 3,
  }),
  npmLane(
    "update-channel-switch",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-channel-switch",
    {
      timeoutMs: 30 * 60 * 1000,
      weight: 3,
    },
  ),
  lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
    resources: ["npm", "service"],
    weight: 6,
  }),
  lane(
    "bundled-plugin-install-uninstall",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-plugin-install-uninstall",
    {
      resources: ["npm"],
      weight: 4,
    },
  ),
  lane(
    "plugins-offline",
    "OPENCLAW_PLUGINS_E2E_CLAWHUB=0 OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
    {
      resources: ["npm", "service"],
      weight: 6,
    },
  ),
  npmLane(
    "bundled-channel-deps-compat",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-channel-deps:fast",
    { resources: ["service"], weight: 3 },
  ),
  npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update"),
  serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload"),
  ...bundledScenarioLanes,
  lane("openai-image-auth", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-image-auth"),
  lane(
    "crestodian-first-run",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-first-run",
  ),
  lane(
    "session-runtime-context",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:session-runtime-context",
  ),
  lane("qr", "pnpm test:docker:qr"),
];

export const tailLanes = [
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
    { timeoutMs: 8 * 60 * 1000 },
  ),
  liveLane(
    "live-codex-harness",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-harness",
    {
      cacheKey: "codex-harness",
      provider: "codex-cli",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
  liveLane("live-codex-bind", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-bind", {
    cacheKey: "codex-harness",
    provider: "codex-cli",
    resources: ["npm"],
    timeoutMs: LIVE_ACP_TIMEOUT_MS,
    weight: 3,
  }),
  liveLane(
    "live-cli-backend-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:codex",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:claude",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:codex",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:droid",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:gemini",
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
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:opencode",
    {
      cacheKey: "acp-bind-opencode",
      provider: "opencode",
      resources: ["npm"],
      timeoutMs: LIVE_ACP_TIMEOUT_MS,
      weight: 3,
    },
  ),
];

const releasePathChunks = {
  core: [
    lane("qr", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:qr"),
    serviceLane("onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard", {
      weight: 2,
    }),
    serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
    serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload"),
    lane(
      "session-runtime-context",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:session-runtime-context",
    ),
    lane(
      "pi-bundle-mcp-tools",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools",
    ),
    serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
      resources: ["npm"],
      weight: 3,
    }),
  ],
  "package-update": [
    npmLane(
      "install-e2e",
      "OPENCLAW_INSTALL_TAG=beta OPENCLAW_E2E_MODELS=both pnpm test:install:e2e",
      {
        resources: ["service"],
        weight: 4,
      },
    ),
    npmLane(
      "npm-onboard-channel-agent",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
      { resources: ["service"], weight: 3 },
    ),
    npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
      weight: 3,
    }),
    npmLane(
      "update-channel-switch",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:update-channel-switch",
      {
        timeoutMs: 30 * 60 * 1000,
        weight: 3,
      },
    ),
  ],
  "plugins-integrations": [
    lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
      resources: ["npm", "service"],
      weight: 6,
    }),
    lane(
      "bundled-plugin-install-uninstall",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-plugin-install-uninstall",
      {
        resources: ["npm"],
        weight: 4,
      },
    ),
    npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update"),
    ...bundledScenarioLanes,
    serviceLane(
      "cron-mcp-cleanup",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
      {
        resources: ["npm"],
        weight: 3,
      },
    ),
    serviceLane(
      "openai-web-search-minimal",
      "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
      { timeoutMs: 8 * 60 * 1000 },
    ),
  ],
  openwebui: [],
};

function openWebUILane() {
  return serviceLane("openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui", {
    timeoutMs: OPENWEBUI_TIMEOUT_MS,
    weight: 5,
  });
}

export function releasePathChunkLanes(chunk, options = {}) {
  const base = releasePathChunks[chunk];
  if (!base) {
    throw new Error(
      `OPENCLAW_DOCKER_ALL_CHUNK must be one of: ${Object.keys(releasePathChunks).join(", ")}. Got: ${JSON.stringify(chunk)}`,
    );
  }
  if (chunk === "openwebui") {
    return options.includeOpenWebUI ? [openWebUILane()] : [];
  }
  if (chunk !== "plugins-integrations" || !options.includeOpenWebUI) {
    return base;
  }
  return [...base, openWebUILane()];
}

export function allReleasePathLanes(options = {}) {
  return Object.keys(releasePathChunks)
    .filter((chunk) => chunk !== "openwebui")
    .flatMap((chunk) =>
      releasePathChunkLanes(chunk, {
        includeOpenWebUI: options.includeOpenWebUI,
      }),
    );
}
