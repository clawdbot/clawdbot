import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { scanInstalledApps } from "../infra/installed-apps.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import { installSkillFromClawHub } from "../skills/lifecycle/clawhub.js";
import {
  acknowledgeOnboardingRecommendations,
  readOnboardingRecommendations,
  writeOnboardingRecommendationsOffer,
  type OnboardingRecommendationsRecord,
} from "../state/onboarding-recommendations.js";
import {
  getSetupAppRecommendations,
  type SetupAppRecommendationMatch,
  type SetupAppRecommendationsResult,
} from "../system-agent/setup-app-recommendations.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

const SKIP_VALUE = "__skip__";

type SetupAppRecommendationDeps = {
  recommend?: () => Promise<SetupAppRecommendationsResult>;
  ensurePlugin?: typeof ensureOnboardingPluginInstalled;
  installSkill?: typeof installSkillFromClawHub;
  resolveOfficialEntry?: (pluginId: string) => OnboardingPluginInstallEntry | undefined;
  readStored?: () => OnboardingRecommendationsRecord | null;
  writeOffer?: typeof writeOnboardingRecommendationsOffer;
  acknowledgeStored?: typeof acknowledgeOnboardingRecommendations;
  deferOfferToBootstrap?: () => boolean;
};

function resolveOfficialEntry(pluginId: string): OnboardingPluginInstallEntry | undefined {
  const catalogEntry = listOfficialExternalPluginCatalogEntries().find(
    (entry) => resolveOfficialExternalPluginId(entry) === pluginId,
  );
  const install = catalogEntry ? resolveOfficialExternalPluginInstall(catalogEntry) : undefined;
  if (!catalogEntry || !install) {
    return undefined;
  }
  return {
    pluginId,
    label: resolveOfficialExternalPluginLabel(catalogEntry),
    install,
    trustedSourceLinkedOfficialInstall: true,
  };
}

function selectionValue(index: number): string {
  return `recommendation:${index}`;
}

function uniqueSelectedMatches(
  matches: SetupAppRecommendationMatch[],
  selected: string[],
): SetupAppRecommendationMatch[] {
  const selectedValues = new Set(selected);
  const seen = new Set<string>();
  return matches.filter((match, index) => {
    const key = `${match.candidate.source}:${match.candidate.id}`;
    if (!selectedValues.has(selectionValue(index)) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function setupAppRecommendations(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  modelRouteVerified: boolean;
  platform?: NodeJS.Platform;
  deps?: SetupAppRecommendationDeps;
}): Promise<OpenClawConfig> {
  const platform = params.platform ?? process.platform;
  // Product decision: default-on "magical" scan with a kill switch, not
  // consent-first. App labels/bundle ids go to the user's configured model and
  // ClawHub search; the scanning progress line and the results note disclose
  // this, and wizard.appRecommendations=false disables the step entirely.
  if (
    params.config.wizard?.appRecommendations === false ||
    platform !== "darwin" ||
    !params.modelRouteVerified
  ) {
    return params.config;
  }
  const readStored = params.deps?.readStored ?? readOnboardingRecommendations;
  const stored = readStored();
  if (typeof stored?.acceptedAt === "number") {
    return params.config;
  }
  const writeOffer = params.deps?.writeOffer ?? writeOnboardingRecommendationsOffer;
  const acknowledgeStored = params.deps?.acknowledgeStored ?? acknowledgeOnboardingRecommendations;
  const deferOfferToBootstrap =
    params.deps?.deferOfferToBootstrap ??
    (() => existsSync(path.join(params.workspaceDir, DEFAULT_BOOTSTRAP_FILENAME)));

  // A pending stored offer means a completed scan's app labels already left
  // the machine once; never rescan or re-query the model for it. Either the
  // bootstrap still owns the ask, or the wizard presents the stored matches.
  let matches: SetupAppRecommendationMatch[];
  let appLabels: string[];
  let recordAnswer: () => void;
  if (stored) {
    if (deferOfferToBootstrap()) {
      return params.config;
    }
    matches = stored.matches;
    appLabels = [...new Set(stored.matches.map((match) => match.appLabel))];
    recordAnswer = () => void acknowledgeStored();
  } else {
    const progress = params.prompter.progress(t("wizard.appRecommendations.scanning"));
    let result: SetupAppRecommendationsResult;
    try {
      result = params.deps?.recommend
        ? await params.deps.recommend()
        : await getSetupAppRecommendations({
            inventorySource: async () => await scanInstalledApps({ platform }),
            runtime: params.runtime,
          });
    } catch (error) {
      progress.stop();
      params.runtime.log(
        t("wizard.appRecommendations.skipped", { reason: formatErrorMessage(error) }),
      );
      return params.config;
    }
    progress.stop();
    if (result.status !== "ok") {
      params.runtime.log(t("wizard.appRecommendations.noneFound"));
      return params.config;
    }
    if (deferOfferToBootstrap()) {
      writeOffer({ inventory: result.apps, matches: result.matches, answered: false });
      return params.config;
    }
    const scanned = result;
    matches = scanned.matches;
    appLabels = scanned.apps.map((app) => app.label);
    recordAnswer = () =>
      void writeOffer({ inventory: scanned.apps, matches: scanned.matches, answered: true });
  }

  await params.prompter.note(
    [
      t("wizard.appRecommendations.detected", { apps: appLabels.join(", ") }),
      t("wizard.appRecommendations.disclosure"),
    ].join("\n"),
    t("wizard.appRecommendations.title"),
  );
  const selected = await params.prompter.multiselect({
    message: t("wizard.appRecommendations.select"),
    options: [
      { value: SKIP_VALUE, label: t("common.skipForNow") },
      ...matches.map((match, index) => ({
        value: selectionValue(index),
        label:
          match.candidate.source === "clawhub-skill"
            ? t("wizard.appRecommendations.optionThirdParty", {
                name: match.candidate.displayName,
                reason: match.reason,
                app: match.appLabel,
              })
            : t("wizard.appRecommendations.option", {
                name: match.candidate.displayName,
                reason: match.reason,
                app: match.appLabel,
              }),
      })),
    ],
    // Supply-chain guard: ClawHub listing text is publisher-controlled and
    // reaches the matcher prompt, so a listing can promote itself to
    // "recommended". Only official catalog entries may be pre-selected;
    // third-party skills always require an explicit opt-in tick.
    initialValues: matches.flatMap((match, index) =>
      match.tier === "recommended" && match.candidate.source !== "clawhub-skill"
        ? [selectionValue(index)]
        : [],
    ),
  });
  // Returning from the prompt means the user answered even when every option
  // was deselected. Cancellation throws before this point.
  recordAnswer();
  if (selected.includes(SKIP_VALUE)) {
    return params.config;
  }

  let next = params.config;
  const ensurePlugin = params.deps?.ensurePlugin ?? ensureOnboardingPluginInstalled;
  const installSkill = params.deps?.installSkill ?? installSkillFromClawHub;
  for (const match of uniqueSelectedMatches(matches, selected)) {
    try {
      if (match.candidate.source === "clawhub-skill") {
        const installed = await installSkill({
          workspaceDir: params.workspaceDir,
          slug: match.candidate.id,
          config: next,
          onClawHubRisk: async () =>
            await params.prompter.confirm({
              message: t("wizard.appRecommendations.skillTrust", {
                name: match.candidate.displayName,
              }),
              initialValue: false,
            }),
          logger: { warn: (message) => params.runtime.error(message) },
        });
        if (!installed.ok) {
          throw new Error(installed.error);
        }
        continue;
      }
      const entry = (params.deps?.resolveOfficialEntry ?? resolveOfficialEntry)(match.candidate.id);
      if (!entry) {
        throw new Error(t("wizard.appRecommendations.catalogEntryMissing"));
      }
      const installed = await ensurePlugin({
        cfg: next,
        entry,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir: params.workspaceDir,
        promptInstall: false,
      });
      next = installed.cfg;
      if (!installed.installed) {
        throw new Error(installed.error ?? installed.status);
      }
    } catch (error) {
      params.runtime.error(
        t("wizard.appRecommendations.installFailed", {
          name: match.candidate.displayName,
          reason: formatErrorMessage(error),
        }),
      );
    }
  }
  return next;
}
