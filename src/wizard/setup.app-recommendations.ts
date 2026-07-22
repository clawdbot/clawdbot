import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "../commands/onboarding-plugin-install.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchClawHubSkillVerification } from "../infra/clawhub.js";
import { formatErrorMessage } from "../infra/errors.js";
import { scanInstalledApps } from "../infra/installed-apps.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../plugins/official-external-plugin-catalog.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  installSkillFromClawHub,
  resolveClawHubSkillVerificationTarget,
} from "../skills/lifecycle/clawhub.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationsStore,
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
  isSkillInstalled?: (params: { workspaceDir: string; skillRef: string }) => Promise<boolean>;
  resolveOfficialEntry?: (pluginId: string) => OnboardingPluginInstallEntry | undefined;
  readStored?: () => OnboardingRecommendationsRecord | null;
  writeOffer?: OnboardingRecommendationsStore["writeOffer"];
  acknowledgeStored?: OnboardingRecommendationsStore["acknowledge"];
  updatePendingStored?: OnboardingRecommendationsStore["updatePending"];
  clearPendingStored?: OnboardingRecommendationsStore["clearPending"];
  deferOfferToBootstrap?: () => boolean;
};

async function isClawHubSkillInstalled(params: {
  workspaceDir: string;
  skillRef: string;
}): Promise<boolean> {
  const target = await resolveClawHubSkillVerificationTarget({
    workspaceDir: params.workspaceDir,
    slug: params.skillRef,
  });
  if (!target.ok || target.resolution.source !== "installed") {
    return false;
  }
  const verification = await fetchClawHubSkillVerification({
    slug: target.slug,
    ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
    version: target.version,
    baseUrl: target.baseUrl,
  });
  return verification.ok && verification.decision === "pass";
}

export type SetupAppRecommendationsOutcome = {
  config: OpenClawConfig;
  commitResult: () => void;
};

function unchangedOutcome(config: OpenClawConfig): SetupAppRecommendationsOutcome {
  return { config, commitResult: () => undefined };
}

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
}): Promise<SetupAppRecommendationsOutcome> {
  const platform = params.platform ?? process.platform;
  // Product decision: default-on "magical" scan with a kill switch, not
  // consent-first. App labels/bundle ids go to the user's configured model and
  // ClawHub search; a static disclosure stays in scrollback before app names
  // leave the machine, while results repeat it. The config flag disables the step.
  if (
    params.config.wizard?.appRecommendations === false ||
    platform !== "darwin" ||
    !params.modelRouteVerified
  ) {
    return unchangedOutcome(params.config);
  }
  const store = createOnboardingRecommendationsStore({ workspaceDir: params.workspaceDir });
  const readStored = params.deps?.readStored ?? store.read;
  const storedRecord = readStored();
  if (typeof storedRecord?.acceptedAt === "number") {
    return unchangedOutcome(params.config);
  }
  const clearPendingStored = params.deps?.clearPendingStored ?? store.clearPending;
  // Pending recommendations are rebuildable cache. Rescan legacy bare
  // ClawHub ids instead of installing without a publisher identity.
  const hasLegacyClawHubId = storedRecord?.matches.some(
    (match) => match.candidate.source === "clawhub-skill" && !match.candidate.id.startsWith("@"),
  );
  if (hasLegacyClawHubId && storedRecord) {
    if (!clearPendingStored({ expected: storedRecord })) {
      return unchangedOutcome(params.config);
    }
  }
  const stored = hasLegacyClawHubId ? null : storedRecord;
  const writeOffer = params.deps?.writeOffer ?? store.writeOffer;
  const acknowledgeStored = params.deps?.acknowledgeStored ?? store.acknowledge;
  const updatePendingStored = params.deps?.updatePendingStored ?? store.updatePending;
  const deferOfferToBootstrap =
    params.deps?.deferOfferToBootstrap ??
    (() => existsSync(path.join(params.workspaceDir, DEFAULT_BOOTSTRAP_FILENAME)));

  // A pending stored offer means a completed scan's app labels already left
  // the machine once; never rescan or re-query the model for it. Either the
  // bootstrap still owns the ask, or the wizard presents the stored matches.
  let matches: SetupAppRecommendationMatch[];
  let appLabels: string[];
  let pendingRecord = stored;
  let recordResult: (retryMatches: SetupAppRecommendationMatch[]) => void;
  const commitStoredResult = (retryMatches: SetupAppRecommendationMatch[]) => {
    if (!pendingRecord) {
      throw new Error("Stored onboarding recommendations changed while setup was running.");
    }
    const expected = pendingRecord;
    const updated =
      retryMatches.length === 0
        ? acknowledgeStored({ expected })
        : updatePendingStored({ matches: retryMatches, expected });
    if (!updated) {
      throw new Error("Stored onboarding recommendations changed while setup was running.");
    }
    pendingRecord = updated;
  };
  if (stored) {
    if (deferOfferToBootstrap()) {
      return unchangedOutcome(params.config);
    }
    matches = stored.matches;
    appLabels = [...new Set(stored.matches.map((match) => match.appLabel))];
    recordResult = commitStoredResult;
  } else {
    const scanDisclosure = t("wizard.appRecommendations.scanDisclosure");
    // Gateway wizards must show the disclosure on the client before app names
    // leave the machine; CLI plain output preserves the same ordering locally.
    if (params.prompter.plain) {
      await params.prompter.plain(scanDisclosure);
    } else {
      params.runtime.log(scanDisclosure);
    }
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
      return unchangedOutcome(params.config);
    }
    progress.stop();
    if (result.status !== "ok") {
      params.runtime.log(t("wizard.appRecommendations.noneFound"));
      return unchangedOutcome(params.config);
    }
    if (deferOfferToBootstrap()) {
      writeOffer({ inventory: result.apps, matches: result.matches, answered: false });
      return unchangedOutcome(params.config);
    }
    const scanned = result;
    matches = scanned.matches;
    appLabels = scanned.apps.map((app) => app.label);
    recordResult = (retryMatches) => {
      if (!pendingRecord) {
        pendingRecord = writeOffer({
          inventory: scanned.apps,
          matches: retryMatches.length > 0 ? retryMatches : scanned.matches,
          answered: retryMatches.length === 0,
        });
        return;
      }
      commitStoredResult(retryMatches);
    };
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
  if (selected.includes(SKIP_VALUE)) {
    recordResult([]);
    return unchangedOutcome(params.config);
  }

  let next = params.config;
  const selectedMatches = uniqueSelectedMatches(matches, selected);
  if (selectedMatches.length === 0) {
    recordResult([]);
    return unchangedOutcome(params.config);
  }
  // Persist the selected set before external installs. Unselected matches are
  // explicit declines; selected matches stay retryable until each install succeeds.
  recordResult(selectedMatches);
  let pendingMatches = selectedMatches;
  const retryMatches: SetupAppRecommendationMatch[] = [];
  const ensurePlugin = params.deps?.ensurePlugin ?? ensureOnboardingPluginInstalled;
  const installSkill = params.deps?.installSkill ?? installSkillFromClawHub;
  const isSkillInstalled = params.deps?.isSkillInstalled ?? isClawHubSkillInstalled;
  for (const match of selectedMatches) {
    let installed = false;
    try {
      if (match.candidate.source === "clawhub-skill") {
        const alreadyInstalled = await isSkillInstalled({
          workspaceDir: params.workspaceDir,
          skillRef: match.candidate.id,
        });
        if (!alreadyInstalled) {
          const result = await installSkill({
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
          if (!result.ok) {
            throw new Error(result.error);
          }
        }
      } else {
        const entry = (params.deps?.resolveOfficialEntry ?? resolveOfficialEntry)(
          match.candidate.id,
        );
        if (!entry) {
          throw new Error(t("wizard.appRecommendations.catalogEntryMissing"));
        }
        const pluginResult = await ensurePlugin({
          cfg: next,
          entry,
          prompter: params.prompter,
          runtime: params.runtime,
          workspaceDir: params.workspaceDir,
          promptInstall: false,
        });
        next = pluginResult.cfg;
        if (!pluginResult.installed) {
          throw new Error(pluginResult.error ?? pluginResult.status);
        }
      }
      installed = true;
    } catch (error) {
      retryMatches.push(match);
      params.runtime.error(
        t("wizard.appRecommendations.installFailed", {
          name: match.candidate.displayName,
          reason: formatErrorMessage(error),
        }),
      );
    }
    if (installed && match.candidate.source === "clawhub-skill") {
      // Skill installation is already durable on disk. Checkpoint it now so a
      // later crash cannot turn an existing target into a permanent retry.
      pendingMatches = pendingMatches.filter((candidate) => candidate !== match);
      recordResult(pendingMatches);
    }
  }
  // Official plugin config is durable only after the caller writes `next`.
  // Commit recommendation outcomes at that owner boundary, never inside the install catch.
  const hasDeferredOfficialResult = selectedMatches.some(
    (match) => match.candidate.source !== "clawhub-skill",
  );
  return {
    config: next,
    commitResult: hasDeferredOfficialResult ? () => recordResult(retryMatches) : () => undefined,
  };
}
