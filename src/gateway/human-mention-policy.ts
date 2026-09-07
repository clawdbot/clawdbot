import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  MAX_HUMAN_MENTIONS,
  MAX_MENTIONABLE_USERS,
  errorShape,
  type ErrorShape,
  type MentionableUser,
  type UsersMentionableParams,
  type UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { listProfiles } from "../state/user-profiles.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
} from "./current-user-profile-display.js";
import {
  authorizeGatewaySessionCreation,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { resolveOperatorSessionCreation } from "./server-methods/session-creation-provenance.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  createProfileSessionEntryFilter,
  isSessionVisibilityAllowed,
  prepareSessionSharing,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "./session-sharing.js";

const MAX_DIRECTORY_PROFILES = 10_000;

type MentionProfile = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
type MentionTarget = {
  agentId: string;
  sessionKey?: string;
  entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">;
};
type MentionReader = { profile: MentionProfile; canRead: (target: MentionTarget) => boolean };

function scopesAllowRead(scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role: "operator",
    requestedScopes: [READ_SCOPE],
    allowedScopes: scopes,
  });
}

/** UI labels are text, never identity or an email-address fallback. */
export function humanMentionDisplayLabel(label: string | undefined, profileId: string): string {
  const text = label
    ?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(text || `Person ${profileId.slice(0, 8)}`, 256);
}

export function createHumanMentionPolicy(params: {
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
}) {
  let profileVersion = -1;
  const displays = new Map<string, CurrentUserProfileDisplay>();
  let directory: { ids: string[]; truncated: boolean } | undefined;
  let eligibleDirectory: { key: string; users: MentionableUser[]; truncated: boolean } | undefined;

  function readProfile(profileId: string): MentionProfile | undefined {
    const version = readUserProfileVersion();
    if (profileVersion !== version) {
      profileVersion = version;
      displays.clear();
      directory = undefined;
      eligibleDirectory = undefined;
    }
    let profile = displays.get(profileId);
    if (!profile) {
      profile = resolveCurrentUserProfileDisplay(profileId);
      if (displays.size >= MAX_DIRECTORY_PROFILES) {
        const oldest = displays.keys().next().value;
        if (oldest !== undefined) {
          displays.delete(oldest);
        }
      }
      displays.set(profileId, profile);
    }
    return profile.kind === "resolved" ? profile : undefined;
  }

  function identify(
    client: GatewayClient | null,
    cfg: OpenClawConfig,
  ): Result<MentionReader, ErrorShape> {
    if (
      !client?.connect ||
      client.invalidated === true ||
      client.internal?.syntheticClient ||
      (client.connect.role ?? "operator") !== "operator" ||
      !scopesAllowRead(client.connect.scopes ?? [])
    ) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Human mentions require a signed-in operator."));
    }
    const verifiedProfile = client.authenticatedUserProfile;
    if (!verifiedProfile?.profileId) {
      return err(
        client.authenticatedGitHubIdentitySync
          ? authenticatedProfileUnavailableError()
          : errorShape(
              ErrorCodes.FORBIDDEN,
              "Human mentions require a verified user profile. Sign in to use mentions.",
            ),
      );
    }
    const profile = readProfile(verifiedProfile.profileId);
    if (!profile) {
      return err(authenticatedProfileUnavailableError());
    }
    const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
    if (policy && !scopesAllowRead(policy.scopes)) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Your operator role cannot read mentions."));
    }
    const admin =
      client.connect.scopes?.includes(ADMIN_SCOPE) &&
      (!policy || policy.scopes.includes(ADMIN_SCOPE));
    // The reader lives for one synchronous projection, never across an await.
    const { entryFilter } = prepareSessionSharing({
      cfg,
      client: {
        connect: { ...client.connect, scopes: admin ? [ADMIN_SCOPE] : [READ_SCOPE] },
        internal: { operatorRoleActor: { kind: "operator", profileId: profile.profileId } },
      },
    });
    return ok({
      profile,
      canRead: (target) => entryFilter?.(target.sessionKey, target.entry) ?? true,
    });
  }

  function recipientProfile(
    profileId: string,
    target: MentionTarget,
    cfg: OpenClawConfig,
  ): MentionProfile | undefined {
    const profile = readProfile(profileId);
    // Administrator read access does not make incognito sessions eligible for mentions.
    if (!profile || target.entry.incognito === true || isIncognitoSessionKey(target.sessionKey)) {
      return undefined;
    }
    const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
    const scopes = policy?.scopes ?? [READ_SCOPE];
    if (!scopesAllowRead(scopes)) {
      return undefined;
    }
    if (scopes.includes(ADMIN_SCOPE)) {
      return profile;
    }
    const entryFilter = createProfileSessionEntryFilter({
      profileId: profile.profileId,
      sessionCap: policy?.sessions.others,
    });
    return entryFilter(target.sessionKey, target.entry) ? profile : undefined;
  }

  function resolveContext(
    client: GatewayClient | null,
    input: UsersMentionableParams,
    cfg: OpenClawConfig,
  ): Result<{ target: MentionTarget; profile: MentionProfile }, ErrorShape> {
    const identified = identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    if ("sessionKey" in input) {
      const agent = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
      if (!agent.ok) {
        return err(agent.error);
      }
      const resolved = resolveSessionSharingTarget({
        cfg,
        sessionKey: input.sessionKey,
        agentId: agent.agentId,
      });
      const target = resolved && {
        agentId: resolved.agentId,
        sessionKey: resolved.canonicalKey,
        entry: {
          createdActor: resolved.entry.createdActor,
          visibility: resolved.entry.visibility,
          incognito: resolved.entry.incognito,
        },
      };
      if (!target || !requester.canRead(target)) {
        return err(errorShape(ErrorCodes.INVALID_REQUEST, "Session was not found."));
      }
      return ok({ target, profile: requester.profile });
    }
    const agent = resolveRequestedSessionAgentId(cfg, undefined, input.agentId);
    if (!agent.ok) {
      return err(agent.error);
    }
    const creationError = authorizeGatewaySessionCreation({
      cfg,
      profileId: requester.profile.profileId,
      agentId: agent.agentId,
    });
    if (creationError) {
      return err(creationError);
    }
    const visibility = resolveSessionVisibility({ visibility: input.visibility });
    if (!isSessionVisibilityAllowed(cfg, visibility)) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, "This session visibility is disabled."));
    }
    return ok({
      profile: requester.profile,
      target: {
        agentId: agent.agentId,
        entry: {
          visibility,
          createdActor: resolveOperatorSessionCreation({
            authenticatedUserProfile: requester.profile,
          }).actor,
        },
      },
    });
  }

  return {
    identify,
    readProfile,
    recipientProfile,
    invalidateDirectory(): void {
      eligibleDirectory = undefined;
    },
    dispose(): void {
      displays.clear();
      directory = undefined;
      eligibleDirectory = undefined;
    },
    mentionable(
      client: GatewayClient | null,
      input: UsersMentionableParams,
    ): Result<UsersMentionableResult, ErrorShape> {
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg);
      if (!context.ok) {
        return context;
      }
      const { target, profile } = context.value;
      if (!directory) {
        const profiles = listProfiles().filter((candidate) => candidate.mergedInto === null);
        directory = {
          ids: profiles.slice(0, MAX_DIRECTORY_PROFILES).map((candidate) => candidate.id),
          truncated: profiles.length > MAX_DIRECTORY_PROFILES,
        };
      }
      // Keystrokes reuse one bounded eligible roster; identity/session/role changes replace it.
      const key = JSON.stringify([profileVersion, target, cfg.gateway?.roles]);
      if (eligibleDirectory?.key !== key) {
        const users = directory.ids.flatMap((id) => {
          const candidate = recipientProfile(id, target, cfg);
          return candidate
            ? [
                {
                  profileId: candidate.profileId,
                  displayName: humanMentionDisplayLabel(candidate.label, candidate.profileId),
                  avatarUrl: candidate.avatarUrl,
                  online: false,
                },
              ]
            : [];
        });
        eligibleDirectory = { key, users, truncated: directory.truncated };
      }
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const users = eligibleDirectory.users.filter(
        (candidate) =>
          candidate.profileId !== profile.profileId &&
          (!query || candidate.displayName.toLocaleLowerCase().includes(query)),
      );
      const names = new Map<string, number>();
      for (const candidate of users) {
        names.set(candidate.displayName, (names.get(candidate.displayName) ?? 0) + 1);
      }
      const online = new Set<string>();
      for (const connected of params.getClients()) {
        const id = connected.authenticatedUserProfile?.profileId;
        if (id && !connected.internal?.syntheticClient) {
          const current = readProfile(id);
          if (current) {
            online.add(current.profileId);
          }
        }
      }
      const projected = users.map((candidate) => ({
        profileId: candidate.profileId,
        displayName:
          (names.get(candidate.displayName) ?? 0) > 1
            ? `${truncateUtf16Safe(candidate.displayName, 244)} (${candidate.profileId.slice(0, 8)})`
            : candidate.displayName,
        avatarUrl: candidate.avatarUrl,
        online: online.has(candidate.profileId),
      }));
      projected.sort(
        (left, right) =>
          Number(right.online) - Number(left.online) ||
          left.displayName.localeCompare(right.displayName) ||
          left.profileId.localeCompare(right.profileId),
      );
      return ok({
        users: projected.slice(0, MAX_MENTIONABLE_USERS),
        truncated: eligibleDirectory.truncated || projected.length > MAX_MENTIONABLE_USERS,
      });
    },
    validateRecipients(
      client: GatewayClient | null,
      input: UsersMentionableParams,
      profileIds: readonly string[],
    ): Result<readonly string[], ErrorShape> {
      if (profileIds.length === 0) {
        return ok([]);
      }
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg);
      if (!context.ok) {
        return context;
      }
      const { target, profile } = context.value;
      const recipients = new Set<string>();
      for (const id of profileIds) {
        const candidate = recipientProfile(id, target, cfg);
        if (
          !candidate ||
          candidate.profileId === profile.profileId ||
          profileIds.length > MAX_HUMAN_MENTIONS
        ) {
          return err(
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "One or more mentioned people are unavailable. Select the recipients again.",
            ),
          );
        }
        recipients.add(candidate.profileId);
      }
      return ok([...recipients]);
    },
  };
}
