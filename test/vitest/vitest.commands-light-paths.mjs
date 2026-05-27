const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

const commandsLightEntries = [
  { source: "src/commands/cleanup-utils.ts", test: "src/commands/cleanup-utils.test.ts" },
  { test: "src/commands/auth-choice.test.ts" },
  {
    source: "src/commands/dashboard.links.ts",
    test: "src/commands/dashboard.links.test.ts",
  },
  { test: "src/commands/daemon-install-helpers.test.ts" },
  { source: "src/commands/doctor-browser.ts", test: "src/commands/doctor-browser.test.ts" },
  {
    source: "src/commands/doctor-gateway-auth-token.ts",
    test: "src/commands/doctor-gateway-auth-token.test.ts",
  },
  {
    source: "src/commands/doctor/shared/channel-plugin-blockers.ts",
    test: "src/commands/doctor/shared/channel-plugin-blockers.test.ts",
  },
  {
    source: "src/commands/doctor/shared/missing-configured-plugin-install.ts",
    test: "src/commands/doctor/shared/missing-configured-plugin-install.test.ts",
  },
  {
    source: "src/commands/doctor/shared/preview-warnings.ts",
    test: "src/commands/doctor/shared/preview-warnings.test.ts",
  },
  {
    source: "src/commands/doctor/shared/release-configured-plugin-installs.ts",
    test: "src/commands/doctor/shared/release-configured-plugin-installs.test.ts",
  },
  {
    source: "src/commands/doctor/shared/stale-plugin-config.ts",
    test: "src/commands/doctor/shared/stale-plugin-config.test.ts",
  },
  {
    source: "src/commands/doctor/shared/stale-oauth-profile-shadows.ts",
    test: "src/commands/doctor/shared/stale-oauth-profile-shadows.test.ts",
  },
  {
    source: "src/commands/gateway-status/helpers.ts",
    test: "src/commands/gateway-status/helpers.test.ts",
  },
  { test: "src/commands/models/auth.test.ts" },
  { test: "src/commands/models/list.auth-index.test.ts" },
  { test: "src/commands/models/list.list-command.forward-compat.test.ts" },
  {
    source: "src/commands/models/list.status-command.ts",
    test: "src/commands/models/list.status.test.ts",
  },
  {
    source: "src/commands/sandbox-formatters.ts",
    test: "src/commands/sandbox-formatters.test.ts",
  },
  {
    source: "src/commands/status-json-command.ts",
    test: "src/commands/status-json-command.test.ts",
  },
  {
    source: "src/commands/status-json-payload.ts",
    test: "src/commands/status-json-payload.test.ts",
  },
  {
    source: "src/commands/status-json-runtime.ts",
    test: "src/commands/status-json-runtime.test.ts",
  },
  {
    source: "src/commands/status-overview-rows.ts",
    test: "src/commands/status-overview-rows.test.ts",
  },
  {
    source: "src/commands/status-overview-surface.ts",
    test: "src/commands/status-overview-surface.test.ts",
  },
  {
    source: "src/commands/status-overview-values.ts",
    test: "src/commands/status-overview-values.test.ts",
  },
  { source: "src/commands/text-format.ts", test: "src/commands/text-format.test.ts" },
];

const commandsLightIncludePatternByFile = new Map(
  commandsLightEntries.flatMap(({ source, test }) =>
    source
      ? [
          [source, test],
          [test, test],
        ]
      : [[test, test]],
  ),
);

export const commandsLightSourceFiles = commandsLightEntries.flatMap(({ source }) =>
  source ? [source] : [],
);
export const commandsLightTestFiles = commandsLightEntries.map(({ test }) => test);

export function isCommandsLightTarget(file) {
  return commandsLightIncludePatternByFile.has(normalizeRepoPath(file));
}

export function isCommandsLightTestFile(file) {
  return commandsLightTestFiles.includes(normalizeRepoPath(file));
}

export function resolveCommandsLightIncludePattern(file) {
  return commandsLightIncludePatternByFile.get(normalizeRepoPath(file)) ?? null;
}
