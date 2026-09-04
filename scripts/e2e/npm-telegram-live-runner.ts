// Telegram package Docker harness.
// Runs QA live transport code against the package candidate installed in Docker.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaProviderMode } from "../../extensions/qa-lab/src/run-config.ts";
import type { QaSuiteRoundTripProbe } from "../../extensions/qa-lab/src/suite-round-trip.ts";
import { normalizeCsvOrLooseStringList } from "../../packages/normalization-core/src/string-normalization.ts";
import { isStrictAffirmativeValue } from "../lib/arg-utils.mts";
import { compareReleaseVersions } from "../lib/release-version.mjs";

function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

function resolveCredentialSource(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE ?? env.OPENCLAW_QA_CREDENTIAL_SOURCE;
}

function resolveCredentialRole(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE ?? env.OPENCLAW_QA_CREDENTIAL_ROLE;
}

function createRunId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resolvePackageTelegramOutputDir(env: NodeJS.ProcessEnv, repoRoot: string) {
  return (
    env.OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR?.trim() ||
    path.join(repoRoot, ".artifacts", "qa-e2e", `npm-telegram-live-${createRunId()}`)
  );
}

const DEFAULT_RTT_CHECK_ID = "channel-canary";
const EXTENDED_STABLE_2026_6_35 = "2026.6.35";
const LEGACY_CONFIG_CUTOFF = "2026.7.2-beta.4";

function projectExtendedStable2026_6_35QaConfig(cfg: OpenClawConfig): OpenClawConfig {
  const { entries, ...agents } = cfg.agents ?? {};
  const { mediaModels, modelPolicy: _modelPolicy, ...defaults } = agents.defaults ?? {};

  return {
    ...cfg,
    // The frozen candidate validates the pre-entries config shape. Keep this
    // projection at the package harness boundary so current runtime stays canonical.
    memory: { backend: "builtin" },
    plugins: {
      ...cfg.plugins,
      bundledDiscovery: "compat",
    },
    agents: {
      ...agents,
      defaults: {
        ...defaults,
        ...(mediaModels?.image ? { imageGenerationModel: mediaModels.image } : {}),
      },
      list: Object.entries(entries ?? {}).map(([id, agent]) => Object.assign({ id }, agent)),
    },
  } as OpenClawConfig;
}

function projectLegacyPackageQaConfig(cfg: OpenClawConfig): OpenClawConfig {
  const { entries, ...agents } = cfg.agents ?? {};
  const { modelPolicy: _modelPolicy, ...legacyDefaults } = agents.defaults ?? {};
  const memory = cfg.memory as
    | (Record<string, unknown> & {
        backend?: unknown;
        citations?: unknown;
        qmd?: unknown;
      })
    | undefined;

  return {
    ...cfg,
    agents: {
      ...agents,
      defaults: legacyDefaults,
      ...(entries
        ? {
            list: Object.entries(entries).map(([id, agent]) => Object.assign({}, agent, { id })),
          }
        : {}),
    },
    memory: memory
      ? Object.fromEntries(
          ["backend", "citations", "qmd"]
            .filter((key) => memory[key] !== undefined)
            .map((key) => [key, memory[key]]),
        )
      : memory,
  } as OpenClawConfig;
}

function resolvePackageConfigMutation(env: NodeJS.ProcessEnv = process.env) {
  const packageVersion = env.OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION?.trim();
  if (packageVersion === EXTENDED_STABLE_2026_6_35) {
    return projectExtendedStable2026_6_35QaConfig;
  }
  const comparison = packageVersion
    ? compareReleaseVersions(packageVersion, LEGACY_CONFIG_CUTOFF)
    : null;
  return comparison !== null && comparison < 0 ? projectLegacyPackageQaConfig : undefined;
}

function resolvePackageTelegramScenarioSelection(env: NodeJS.ProcessEnv) {
  const scenarioIds = normalizeCsvOrLooseStringList(env.OPENCLAW_NPM_TELEGRAM_SCENARIOS);
  const explicitCheckIds = normalizeCsvOrLooseStringList(env.OPENCLAW_NPM_TELEGRAM_RTT_CHECKS);
  if (explicitCheckIds.length > 1) {
    throw new Error(
      `OPENCLAW_NPM_TELEGRAM_RTT_CHECKS accepts at most one scenario id; got ${explicitCheckIds.length}`,
    );
  }
  const explicitRttScenarioId = explicitCheckIds[0];
  return {
    explicitRttScenarioId,
    scenarioIds: explicitRttScenarioId
      ? [
          explicitRttScenarioId,
          ...scenarioIds.filter((scenarioId) => scenarioId !== explicitRttScenarioId),
        ]
      : scenarioIds,
  };
}

function resolvePackageTelegramScenarios(
  env: NodeJS.ProcessEnv,
  resolveScenarioIds: (scenarioIds: readonly string[]) => string[],
) {
  const selection = resolvePackageTelegramScenarioSelection(env);
  return {
    ...selection,
    resolvedScenarioIds: resolveScenarioIds(selection.scenarioIds),
  };
}

function resolveRttOptions(env: NodeJS.ProcessEnv, selectedScenarioIds: readonly string[] = []) {
  const { explicitRttScenarioId } = resolvePackageTelegramScenarioSelection(env);
  if (
    !explicitRttScenarioId &&
    selectedScenarioIds.length > 0 &&
    !selectedScenarioIds.includes(DEFAULT_RTT_CHECK_ID)
  ) {
    return undefined;
  }
  const count = parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES") ?? 20;
  return {
    scenarioId: explicitRttScenarioId ?? DEFAULT_RTT_CHECK_ID,
    count,
    timeoutMs: parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS") ?? 30_000,
    maxFailures: parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES") ?? count,
  };
}

function createRoundTripProbe(
  options: ReturnType<typeof resolveRttOptions>,
): QaSuiteRoundTripProbe | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...options,
    markerPrefix: "QA-TELEGRAM-RTT",
    input: {
      conversation: { id: "telegram-rtt-room", kind: "group" },
      senderId: "qa-rtt-driver",
      senderName: "QA RTT Driver",
    },
    textPrefix: "@openclaw Telegram RTT check. Reply exactly: ",
    chainReplies: true,
  };
}

function prioritizeRoundTripProbeScenario(
  scenarioIds: readonly string[],
  options: ReturnType<typeof resolveRttOptions>,
) {
  if (!options) {
    return [...scenarioIds];
  }
  return [
    options.scenarioId,
    ...scenarioIds.filter((scenarioId) => scenarioId !== options.scenarioId),
  ];
}

async function shouldFailPackageTelegramRun(
  result: { summaryPath: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (isStrictAffirmativeValue(env.OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES)) {
    return false;
  }
  const { readQaSuiteFailedOrSkippedScenarioCountFromFile } =
    await import("../../extensions/qa-lab/src/suite-summary.ts");
  return (await readQaSuiteFailedOrSkippedScenarioCountFromFile(result.summaryPath)) > 0;
}

async function resolveTrustedOpenClawCommand(
  rawCommand: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!path.isAbsolute(rawCommand)) {
    throw new Error("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must be an absolute path.");
  }
  const commandName = path.basename(rawCommand);
  if (commandName !== "openclaw" && commandName !== "openclaw.cmd") {
    throw new Error(
      `OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must point to openclaw; got: ${commandName}`,
    );
  }
  const npmPrefix = env.NPM_CONFIG_PREFIX?.trim();
  if (!npmPrefix) {
    throw new Error("Missing NPM_CONFIG_PREFIX for installed openclaw command validation.");
  }
  const [realCommand, realPrefix] = await Promise.all([
    fs.realpath(rawCommand),
    fs.realpath(npmPrefix),
  ]);
  if (realCommand !== realPrefix && !realCommand.startsWith(`${realPrefix}${path.sep}`)) {
    throw new Error("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must resolve inside NPM_CONFIG_PREFIX.");
  }
  return {
    executablePath: rawCommand,
    usePackagedPlugins: true,
  } as const;
}

async function main() {
  const [
    { runQaTelegramSuite },
    { resolveTelegramQaScenarioIds },
    { DEFAULT_QA_LIVE_PROVIDER_MODE },
  ] = await Promise.all([
    import("../../extensions/qa-lab/src/live-transports/telegram/cli.runtime.ts"),
    import("../../extensions/qa-lab/src/live-transports/telegram/scenario-selection.ts"),
    import("../../extensions/qa-lab/src/providers/index.ts"),
  ]);
  const rawSutOpenClawCommand = process.env.OPENCLAW_NPM_TELEGRAM_SUT_COMMAND?.trim();
  if (!rawSutOpenClawCommand) {
    throw new Error("Missing OPENCLAW_NPM_TELEGRAM_SUT_COMMAND.");
  }
  const sutOpenClawCommand = await resolveTrustedOpenClawCommand(rawSutOpenClawCommand);
  const mutateConfig = resolvePackageConfigMutation();

  const repoRoot = path.resolve(process.env.OPENCLAW_NPM_TELEGRAM_REPO_ROOT ?? process.cwd());
  const outputDir = resolvePackageTelegramOutputDir(process.env, repoRoot);
  const providerMode =
    (process.env.OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE as QaProviderMode | undefined) ??
    DEFAULT_QA_LIVE_PROVIDER_MODE;
  const primaryModel = process.env.OPENCLAW_NPM_TELEGRAM_MODEL;
  const { scenarioIds, resolvedScenarioIds } = resolvePackageTelegramScenarios(
    process.env,
    (requestedScenarioIds) =>
      resolveTelegramQaScenarioIds({
        providerMode,
        primaryModel,
        scenarioIds: requestedScenarioIds,
      }),
  );
  const rttOptions = resolveRttOptions(process.env, scenarioIds);
  const result = await runQaTelegramSuite({
    allowFailures: true,
    failFast: true,
    repoRoot,
    outputDir,
    sutOpenClawCommand,
    providerMode,
    primaryModel,
    alternateModel: process.env.OPENCLAW_NPM_TELEGRAM_ALT_MODEL,
    fastMode: isStrictAffirmativeValue(process.env.OPENCLAW_NPM_TELEGRAM_FAST),
    scenarioIds,
    resolvedScenarioIds: prioritizeRoundTripProbeScenario(resolvedScenarioIds, rttOptions),
    roundTripProbe: createRoundTripProbe(rttOptions),
    ...(mutateConfig ? { mutateConfig } : {}),
    sutAccountId: process.env.OPENCLAW_NPM_TELEGRAM_SUT_ACCOUNT,
    credentialSource: resolveCredentialSource(process.env),
    credentialRole: resolveCredentialRole(process.env),
  });
  if (!result) {
    throw new Error("Package Telegram QA did not produce suite artifacts.");
  }

  process.stdout.write(`Package Telegram QA report: ${result.reportPath}\n`);
  process.stdout.write(`Package Telegram QA summary: ${result.summaryPath}\n`);
  if (await shouldFailPackageTelegramRun(result)) {
    process.exitCode = 1;
  }
}

async function formatRunnerErrorMessage(error: unknown) {
  try {
    // Widen the specifier so the source-only test-root program does not try to
    // resolve dist (TS2307); the docker-e2e boundary guard requires importing
    // built dist here, so the cast stays structural instead of a src reference.
    const distErrorsPath = "../../dist/infra/errors.js" as string;
    const { formatErrorMessage } = (await import(distErrorsPath)) as {
      formatErrorMessage: (err: unknown) => string;
    };
    return formatErrorMessage(error);
  } catch {
    return error instanceof Error ? error.message : String(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error: unknown) => {
    process.stderr.write(
      `package telegram live e2e failed: ${await formatRunnerErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export const testing = {
  resolvePackageTelegramOutputDir,
  resolvePackageConfigMutation,
  resolvePackageTelegramScenarioSelection,
  resolvePackageTelegramScenarios,
  resolveCredentialRole,
  resolveCredentialSource,
  createRoundTripProbe,
  prioritizeRoundTripProbeScenario,
  resolveRttOptions,
  resolveTrustedOpenClawCommand,
  shouldFailPackageTelegramRun,
};
