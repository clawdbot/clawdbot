// Plans release workflow matrix entries from profile and suite inputs.
const DOCKER_E2E_CHUNKS = [
  {
    chunk_id: "core",
    label: "core",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "package-update-openai",
    label: "package/update OpenAI install",
    timeout_minutes: 45,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "package-update-anthropic",
    label: "package/update Anthropic install",
    timeout_minutes: 60,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "package-update-core",
    label: "package/update core",
    timeout_minutes: 60,
    profiles: "beta minimum stable full",
  },
  {
    chunk_id: "plugins-runtime-plugins",
    label: "plugins/runtime plugins",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-services",
    label: "plugins/runtime services",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-a",
    label: "plugins/runtime install A",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-b",
    label: "plugins/runtime install B",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-c",
    label: "plugins/runtime install C",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-d",
    label: "plugins/runtime install D",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-e",
    label: "plugins/runtime install E",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-f",
    label: "plugins/runtime install F",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-g",
    label: "plugins/runtime install G",
    timeout_minutes: 60,
    profiles: "stable full",
  },
  {
    chunk_id: "plugins-runtime-install-h",
    label: "plugins/runtime install H",
    timeout_minutes: 60,
    profiles: "stable full",
  },
];

const LIVE_MODEL_PROVIDERS = [
  {
    provider_label: "Anthropic",
    providers: "anthropic",
    profiles: "stable full",
  },
  {
    provider_label: "Google",
    providers: "google",
    profiles: "stable full",
  },
  {
    provider_label: "MiniMax",
    providers: "minimax",
    profiles: "stable full",
  },
  {
    provider_label: "OpenAI",
    providers: "openai",
    profiles: "beta minimum stable full",
  },
  {
    provider_label: "OpenCode",
    providers: "opencode-go",
    profiles: "full",
  },
  {
    provider_label: "OpenRouter",
    providers: "openrouter",
    profiles: "full",
  },
  {
    provider_label: "xAI",
    providers: "xai",
    profiles: "full",
  },
  {
    provider_label: "Z.ai",
    providers: "zai",
    profiles: "full",
  },
  {
    provider_label: "Fireworks",
    providers: "fireworks",
    profiles: "full",
  },
];

function isEnabled(value) {
  return value === true || value === "true";
}

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function profileIncludes(entry, profile) {
  return entry.profiles.split(/\s+/u).includes(profile);
}

function planProfileMatrix(entries, profile, enabled, disabledReason, labelForEntry) {
  const selected = enabled ? entries.filter((entry) => profileIncludes(entry, profile)) : [];
  const omitted = entries
    .filter((entry) => !selected.includes(entry))
    .map((entry) => ({
      id: labelForEntry(entry),
      label: entry.label ?? entry.provider_label ?? labelForEntry(entry),
      reason: enabled ? `requires one of: ${entry.profiles}` : disabledReason,
    }));

  return {
    count: selected.length,
    matrix: { include: selected },
    omitted,
  };
}

/**
 * Creates the Docker E2E/live model matrix plan for a release profile.
 */
export function createReleaseWorkflowMatrixPlan(options = {}) {
  const releaseProfile = options.releaseProfile ?? "stable";
  const dockerE2eEnabled =
    isEnabled(options.includeReleasePathSuites) && isBlank(options.dockerLanes);
  const liveModelsEnabled =
    isEnabled(options.includeLiveSuites) &&
    isBlank(options.liveModelProviders) &&
    (isBlank(options.liveSuiteFilter) || options.liveSuiteFilter === "docker-live-models");

  return {
    dockerE2e: planProfileMatrix(
      DOCKER_E2E_CHUNKS,
      releaseProfile,
      dockerE2eEnabled,
      "release-path Docker E2E chunks disabled by input selection",
      (entry) => entry.chunk_id,
    ),
    liveModels: planProfileMatrix(
      LIVE_MODEL_PROVIDERS,
      releaseProfile,
      liveModelsEnabled,
      "Docker live model matrix disabled by input selection",
      (entry) => entry.providers,
    ),
    releaseProfile,
  };
}

function markdownForPlan(plan) {
  const sections = [
    ["Docker E2E release chunks", plan.dockerE2e],
    ["Docker live model providers", plan.liveModels],
  ];
  const lines = [
    `## Release workflow matrix plan`,
    "",
    `Release profile: \`${plan.releaseProfile}\``,
  ];

  for (const [title, section] of sections) {
    lines.push("", `### ${title}`, "", `Selected lanes: ${section.count}`);
    if (section.omitted.length === 0) {
      lines.push("", "No lanes omitted.");
      continue;
    }
    lines.push("", "| Omitted lane | Reason |", "| --- | --- |");
    for (const omitted of section.omitted) {
      lines.push(`| \`${omitted.id}\` | ${omitted.reason} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeOutputs(plan) {
  const outputs = {
    docker_e2e_count: String(plan.dockerE2e.count),
    docker_e2e_matrix: JSON.stringify(plan.dockerE2e.matrix),
    docker_e2e_omitted_json: JSON.stringify(plan.dockerE2e.omitted),
    live_models_count: String(plan.liveModels.count),
    live_models_matrix: JSON.stringify(plan.liveModels.matrix),
    live_models_omitted_json: JSON.stringify(plan.liveModels.omitted),
  };

  for (const [key, value] of Object.entries(outputs)) {
    console.log(`${key}=${value}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plan = createReleaseWorkflowMatrixPlan({
    dockerLanes: process.env.DOCKER_LANES,
    includeLiveSuites: process.env.INCLUDE_LIVE_SUITES,
    includeReleasePathSuites: process.env.INCLUDE_RELEASE_PATH_SUITES,
    liveModelProviders: process.env.LIVE_MODEL_PROVIDERS,
    liveSuiteFilter: process.env.LIVE_SUITE_FILTER,
    releaseProfile: process.env.RELEASE_TEST_PROFILE,
  });

  writeOutputs(plan);
  const summary = markdownForPlan(plan);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}
