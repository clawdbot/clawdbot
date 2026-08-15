// Machine-local onboarding recovery owns receipt identity and completion validation.
import { resolveSystemAgentOnboardingTarget } from "../commands/onboard-agent-target.js";
import { readConfigFileSnapshot, withConfigMutationExclusive } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  completeLocalOnboarding,
  readLocalOnboardingStateForConfig,
  type LocalOnboardingState,
} from "../state/local-onboarding-state.js";
import { resolveUserPath } from "../utils.js";

type SetupConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

export type LocalSetupRecovery = {
  workspace: string;
  applyOptions?: {
    resume: true;
    assertCommitPreconditions: (sourceConfig: OpenClawConfig) => void;
  };
  complete: (
    appliedConfigPath: string,
    authorize: <T>(effect: () => Promise<T> | T) => Promise<T>,
  ) => Promise<SetupConfigSnapshot | undefined>;
};

/** Keep canonical config mutations excluded until the SQLite ownership CAS commits. */
export async function completeLocalSetupRecovery(params: {
  owner: LocalOnboardingState;
  appliedConfigPath: string;
}): Promise<SetupConfigSnapshot> {
  return await withConfigMutationExclusive(async (lockedSourceConfig) => {
    const snapshot = await readConfigFileSnapshot();
    const sourceConfig = snapshot.sourceConfig ?? snapshot.config;
    if (
      !snapshot.exists ||
      !snapshot.valid ||
      !snapshot.path ||
      resolveUserPath(snapshot.path) !== params.owner.configPath ||
      (params.appliedConfigPath &&
        resolveUserPath(params.appliedConfigPath) !== params.owner.configPath) ||
      lockedSourceConfig.wizard?.securityAcknowledgedAt !== params.owner.securityAcknowledgedAt ||
      sourceConfig.wizard?.securityAcknowledgedAt !== params.owner.securityAcknowledgedAt ||
      resolveUserPath(
        resolveSystemAgentOnboardingTarget(snapshot.runtimeConfig ?? snapshot.config).workspaceDir,
      ) !== params.owner.workspace
    ) {
      throw new Error("The onboarding configuration changed before setup could complete.");
    }
    if (
      readLocalOnboardingStateForConfig(snapshot.path, sourceConfig)?.runId !==
        params.owner.runId ||
      !completeLocalOnboarding({ configPath: snapshot.path, runId: params.owner.runId })
    ) {
      throw new Error("Another onboarding run replaced this setup operation. Retry onboarding.");
    }
    return snapshot;
  });
}

/** Adopt only a valid, local, same-workspace onboarding receipt. */
export async function loadLocalSetupRecovery(
  requestedWorkspace?: string,
): Promise<LocalSetupRecovery> {
  const snapshot = await readConfigFileSnapshot();
  const recorded =
    snapshot.exists &&
    snapshot.valid &&
    (snapshot.sourceConfig ?? snapshot.config)?.gateway?.mode !== "remote"
      ? readLocalOnboardingStateForConfig(snapshot.path, snapshot.sourceConfig ?? snapshot.config)
      : undefined;
  const pending = recorded?.status === "pending" ? recorded : undefined;
  const workspace = resolveUserPath(requestedWorkspace ?? pending?.workspace ?? process.cwd());
  if (pending && workspace !== resolveUserPath(pending.workspace)) {
    throw new Error(
      "Another onboarding run owns a different workspace. Retry onboarding with its approved workspace.",
    );
  }
  const assertOwner = (sourceConfig: OpenClawConfig) => {
    if (
      pending &&
      readLocalOnboardingStateForConfig(snapshot.path, sourceConfig)?.runId !== pending.runId
    ) {
      throw new Error("Another onboarding run replaced this setup operation. Retry onboarding.");
    }
  };
  return {
    workspace,
    ...(pending
      ? { applyOptions: { resume: true as const, assertCommitPreconditions: assertOwner } }
      : {}),
    async complete(appliedConfigPath, authorize) {
      if (!pending) {
        return undefined;
      }
      return await authorize(() =>
        completeLocalSetupRecovery({ owner: pending, appliedConfigPath }),
      );
    },
  };
}
