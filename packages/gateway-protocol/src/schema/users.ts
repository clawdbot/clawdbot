// Gateway Protocol schemas for durable user profiles and email aliases.
import type { Static } from "typebox";
import { Type } from "typebox";
import {
  GitHubIdentityFactsSchema,
  ToolsGitHubAuthorizePendingResultSchema,
  ToolsGitHubAuthorizeSlowDownResultSchema,
  ToolsGitHubAuthorizeAccessDeniedResultSchema,
  ToolsGitHubAuthorizeExpiredResultSchema,
  ToolsGitHubAuthorizeIncorrectDeviceCodeResultSchema,
  ToolsGitHubAuthorizeNetworkErrorResultSchema,
  ToolsGitHubAuthorizeFailedResultSchema,
} from "./agents-models-skills.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const USER_PREFS_ENTRY_LIMIT = 32;
export const USER_PREFS_PROFILE_KEY_LIMIT = 128;
export const USER_PREFS_VALUE_BYTES = 4 * 1024;
export const GIT_COAUTHOR_PREFERENCE_KEY = "git.coauthor.enabled";
export const GATEWAY_OWNER_PROFILE_ID = "gateway-owner";

// Credit ships on for verified GitHub identities: an absent row is the default, not a
// refusal, so clearing the row on an account change restores the default instead of
// revoking credit. The preference API persists arbitrary JSON, so anything other than a
// missing row or literal `true` fails closed rather than publishing a person's trailer.
export function isGitCoauthorCreditEnabled(value: unknown): boolean {
  return value === undefined || value === true;
}

export {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
  type UiAppearancePreferenceKey,
} from "./ui-appearance-preferences.js";

const UserProfileIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const UserProfileDisplayNameSchema = Type.String({ maxLength: 256 });
const UserProfileRoleSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const UserPreferenceKeySchema = Type.String({ pattern: "^.{1,256}$" });
const UserPreferenceEntriesSchema = Type.Record(UserPreferenceKeySchema, Type.Unknown());
const UserPreferenceSetEntriesSchema = Type.Record(UserPreferenceKeySchema, Type.Unknown(), {
  maxProperties: USER_PREFS_ENTRY_LIMIT,
});
export const UserProfileAvatarMimeSchema = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("image/jpeg"),
  Type.Literal("image/webp"),
]);
export const UserProfileGitHubIdentitySchema = closedObject({
  login: Type.String({ minLength: 1, maxLength: 39 }),
  profileUrl: NonEmptyString,
  avatarUrl: NonEmptyString,
});

export const UserProfileSchema = closedObject({
  id: UserProfileIdSchema,
  displayName: Type.Union([UserProfileDisplayNameSchema, Type.Null()]),
  avatarMime: Type.Union([UserProfileAvatarMimeSchema, Type.Null()]),
  mergedInto: Type.Union([UserProfileIdSchema, Type.Null()]),
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  emails: Type.Array(NonEmptyString),
  githubIdentity: Type.Union([UserProfileGitHubIdentitySchema, Type.Null()]),
  hasAvatar: Type.Boolean(),
  role: Type.Optional(UserProfileRoleSchema),
});

export const UsersListParamsSchema = closedObject({});
export const UsersListResultSchema = closedObject({ profiles: Type.Array(UserProfileSchema) });

export const UsersSelfParamsSchema = closedObject({});
export const UsersSelfResultSchema = closedObject({ profile: UserProfileSchema });

export const UsersLinkEmailParamsSchema = closedObject({
  email: Type.String({ minLength: 1, maxLength: 320 }),
  targetProfileId: UserProfileIdSchema,
});
export const UsersLinkEmailResultSchema = closedObject({ profile: UserProfileSchema });

export const UsersSetDisplayNameParamsSchema = closedObject({
  profileId: UserProfileIdSchema,
  displayName: Type.Union([UserProfileDisplayNameSchema, Type.Null()]),
});
export const UsersSetDisplayNameResultSchema = closedObject({ profile: UserProfileSchema });

export const UsersSetRoleParamsSchema = closedObject({
  profileId: UserProfileIdSchema,
  role: Type.Union([UserProfileRoleSchema, Type.Null()]),
});
export const UsersSetRoleResultSchema = closedObject({ profile: UserProfileSchema });

export const UsersSetAvatarParamsSchema = closedObject({
  profileId: UserProfileIdSchema,
  mime: UserProfileAvatarMimeSchema,
  avatarBase64: Type.String({ minLength: 1, maxLength: 700_000 }),
});
export const UsersSetAvatarResultSchema = closedObject({
  profile: UserProfileSchema,
  avatarRevision: NonEmptyString,
});

export const UsersPrefsGetParamsSchema = closedObject({
  keys: Type.Optional(
    Type.Array(UserPreferenceKeySchema, {
      maxItems: USER_PREFS_ENTRY_LIMIT,
      uniqueItems: true,
    }),
  ),
});
export const UsersPrefsGetResultSchema = Type.Union([
  closedObject({ status: Type.Literal("ok"), entries: UserPreferenceEntriesSchema }),
  closedObject({ status: Type.Literal("no_durable_identity") }),
]);
export const UsersPrefsSetParamsSchema = closedObject({ entries: UserPreferenceSetEntriesSchema });
export const UsersPrefsSetResultSchema = Type.Union([
  closedObject({ status: Type.Literal("ok") }),
  closedObject({ status: Type.Literal("no_durable_identity") }),
]);
export const UsersPrefsChangedEventSchema = closedObject({
  profileId: UserProfileIdSchema,
  keys: Type.Array(UserPreferenceKeySchema, {
    maxItems: USER_PREFS_ENTRY_LIMIT,
    uniqueItems: true,
  }),
});

export type UserProfile = Static<typeof UserProfileSchema>;
export type UserProfileGitHubIdentity = Static<typeof UserProfileGitHubIdentitySchema>;
export type UsersListParams = Static<typeof UsersListParamsSchema>;
export type UsersListResult = Static<typeof UsersListResultSchema>;
export type UsersSelfParams = Static<typeof UsersSelfParamsSchema>;
export type UsersSelfResult = Static<typeof UsersSelfResultSchema>;
export type UsersLinkEmailParams = Static<typeof UsersLinkEmailParamsSchema>;
export type UsersLinkEmailResult = Static<typeof UsersLinkEmailResultSchema>;
export type UsersSetDisplayNameParams = Static<typeof UsersSetDisplayNameParamsSchema>;
export type UsersSetDisplayNameResult = Static<typeof UsersSetDisplayNameResultSchema>;
export type UsersSetRoleParams = Static<typeof UsersSetRoleParamsSchema>;
export type UsersSetRoleResult = Static<typeof UsersSetRoleResultSchema>;
export type UsersSetAvatarParams = Static<typeof UsersSetAvatarParamsSchema>;
export type UsersSetAvatarResult = Static<typeof UsersSetAvatarResultSchema>;
export type UsersPrefsGetParams = Static<typeof UsersPrefsGetParamsSchema>;
export type UsersPrefsGetResult = Static<typeof UsersPrefsGetResultSchema>;
export type UsersPrefsSetParams = Static<typeof UsersPrefsSetParamsSchema>;
export type UsersPrefsSetResult = Static<typeof UsersPrefsSetResultSchema>;
export type UsersPrefsChangedEvent = Static<typeof UsersPrefsChangedEventSchema>;

export const PersonalGitHubGenerationSchema = Type.String({ format: "uuid", maxLength: 36 });
export const PersonalGitHubAccountSchema = closedObject({
  accountId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  login: Type.String({
    minLength: 1,
    maxLength: 39,
    pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
  }),
});
export const UsersGitHubAuthorizeStartParamsSchema = closedObject({});
export const UsersGitHubAuthorizeStartResultSchema = closedObject({
  requestId: PersonalGitHubGenerationSchema,
  userCode: Type.String({ pattern: "^[A-Z0-9]{4}-[A-Z0-9]{4}$" }),
  verificationUri: Type.Literal("https://github.com/login/device"),
  expiresInMs: Type.Integer({ minimum: 0, maximum: 900000 }),
  pollAfterMs: Type.Integer({ minimum: 1, maximum: 60000 }),
});
export const UsersGitHubAuthorizePollParamsSchema = closedObject({
  requestId: PersonalGitHubGenerationSchema,
});
export const UsersGitHubAuthorizeCancelParamsSchema = closedObject({
  requestId: PersonalGitHubGenerationSchema,
});
export const UsersGitHubAuthorizeCancelResultSchema = closedObject({ cancelled: Type.Boolean() });
export const UsersGitHubDisconnectParamsSchema = closedObject({});
export const UsersGitHubDisconnectResultSchema = closedObject({ disconnected: Type.Literal(true) });
export const PersonalGitHubStatusSchema = closedObject({
  state: Type.Union([
    Type.Literal("connected"),
    Type.Literal("disconnected"),
    Type.Literal("unavailable"),
  ]),
  generation: Type.Union([PersonalGitHubGenerationSchema, Type.Null()]),
  account: Type.Union([PersonalGitHubAccountSchema, Type.Null()]),
  accessExpiresAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  refreshState: Type.Union([
    Type.Literal("available"),
    Type.Literal("refreshing"),
    Type.Literal("expired"),
    Type.Literal("failed"),
    Type.Literal("not_applicable"),
  ]),
  pending: Type.Union([UsersGitHubAuthorizeStartResultSchema, Type.Null()]),
});
export const UsersGitHubStatusParamsSchema = closedObject({});
export const UsersGitHubStatusResultSchema = closedObject({
  personal: PersonalGitHubStatusSchema,
  system: GitHubIdentityFactsSchema,
});
export const UsersGitHubAuthorizePollResultSchema = Type.Union([
  ToolsGitHubAuthorizePendingResultSchema,
  ToolsGitHubAuthorizeSlowDownResultSchema,
  ToolsGitHubAuthorizeAccessDeniedResultSchema,
  ToolsGitHubAuthorizeExpiredResultSchema,
  ToolsGitHubAuthorizeIncorrectDeviceCodeResultSchema,
  ToolsGitHubAuthorizeNetworkErrorResultSchema,
  ToolsGitHubAuthorizeFailedResultSchema,
  closedObject({ status: Type.Literal("success"), personal: PersonalGitHubStatusSchema }),
]);
export type PersonalGitHubStatus = Static<typeof PersonalGitHubStatusSchema>;
export type UsersGitHubStatusResult = Static<typeof UsersGitHubStatusResultSchema>;
export type UsersGitHubAuthorizeStartResult = Static<typeof UsersGitHubAuthorizeStartResultSchema>;
export type UsersGitHubAuthorizePollResult = Static<typeof UsersGitHubAuthorizePollResultSchema>;
