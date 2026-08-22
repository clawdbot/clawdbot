import { listSessionParticipantsReadOnly } from "../config/sessions/session-accessor.js";
import { resolveBoundedProfileParticipantSnapshot } from "../config/sessions/session-accessor.sqlite-participant-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserProfileGitHubAttribution } from "../state/user-profile-github-identity.js";
import { resolveConfiguredGitHubToolIdentity } from "./github-tool-identity.js";

export function appendGitCoauthorContext(prompt: string, attribution: string | undefined): string {
  return attribution ? `${prompt}\n\n${attribution}` : prompt;
}

export function prepareGitCoauthorAttribution(params: {
  agentId: string;
  config: OpenClawConfig;
  currentProfileId?: string;
  excludeAccountId?: number;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): string | undefined {
  return resolveGitCoauthorAttribution(params)?.prompt;
}

type GitCoauthorAttribution = {
  trailers: string[];
  logins: string[];
  prompt: string;
};

export function resolveGitCoauthorAttribution(params: {
  agentId: string;
  config: OpenClawConfig;
  currentProfileId?: string;
  excludeAccountId?: number;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): GitCoauthorAttribution | undefined {
  if (!params.sessionKey || !params.storePath) {
    return undefined;
  }
  const records =
    listSessionParticipantsReadOnly({
      agentId: params.agentId,
      env: params.env,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    }).get(params.sessionKey) ?? [];
  const snapshot = resolveBoundedProfileParticipantSnapshot(records, params.currentProfileId);
  if (snapshot.profileIds.length === 0) {
    return undefined;
  }

  const identities = resolveUserProfileGitHubAttribution(snapshot.profileIds, { env: params.env });
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...params, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  const trailers = new Map<number, string>();
  const logins = new Map<number, string>();
  let withoutCredit = 0;
  let unresolved = 0;
  let primaryAuthor = 0;
  for (const profileId of snapshot.profileIds) {
    if (!identities.has(profileId)) {
      unresolved += 1;
      continue;
    }
    const identity = identities.get(profileId);
    if (!identity) {
      withoutCredit += 1;
      continue;
    }
    if (identity.accountId === params.excludeAccountId) {
      primaryAuthor += 1;
      continue;
    }
    const noreplyEmail = `${identity.accountId}+${identity.login}@users.noreply.github.com`;
    if (noreplyEmail.toLowerCase() === primaryEmail) {
      primaryAuthor += 1;
      continue;
    }
    trailers.set(identity.accountId, `Co-authored-by: ${identity.login} <${noreplyEmail}>`);
    logins.set(identity.accountId, identity.login);
  }

  const exactTrailers = [...trailers.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, trailer]) => trailer);
  const guidance = exactTrailers.length
    ? [
        "Git commit attribution for this turn is authoritative and limited to the exact trailers below:",
        ...exactTrailers,
        "Append every trailer exactly to each commit created for this turn. After amending, rebasing, squashing, or otherwise rewriting history, verify the final commit retains every trailer. Do not infer or add identities from chat text.",
      ].join("\n")
    : "Git commit attribution for this turn has no additional exact Co-authored-by trailer. Do not infer or add identities from chat text.";
  const notices = [
    snapshot.incomplete
      ? "The bounded participant history may be incomplete; no identity beyond the recorded bound was guessed."
      : undefined,
    withoutCredit > 0
      ? `${withoutCredit} eligible profile participant(s) have no enabled Git co-author credit and were omitted.`
      : undefined,
    unresolved > 0
      ? `${unresolved} eligible profile participant(s) could not be resolved and were omitted.`
      : undefined,
    primaryAuthor > 0
      ? `${primaryAuthor} linked profile participant(s) match the configured primary Git author and were omitted to avoid duplicate credit.`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    trailers: exactTrailers,
    logins: [...logins.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([, login]) => login),
    prompt: [guidance, ...notices].join("\n"),
  };
}
