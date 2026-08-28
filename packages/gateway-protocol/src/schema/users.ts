// Gateway Protocol schemas for durable user profiles and email aliases.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const USER_PREFS_ENTRY_LIMIT = 32;
export const USER_PREFS_PROFILE_KEY_LIMIT = 128;
export const USER_PREFS_VALUE_BYTES = 4 * 1024;
export const GIT_COAUTHOR_PREFERENCE_KEY = "git.coauthor.enabled";

// Credit ships on for verified GitHub identities: an absent row is the default, not a
// refusal, so only an explicit `false` opts out and clearing the row on an account
// change restores the default instead of revoking credit.
export function isGitCoauthorCreditEnabled(value: unknown): boolean {
  return value !== false;
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
