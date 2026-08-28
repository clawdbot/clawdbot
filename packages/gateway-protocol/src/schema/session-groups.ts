import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

const SidebarSectionIdString = Type.String({ minLength: 1, maxLength: 512 });

/** Lists the gateway-owned custom session group catalog (names + order). */
export const SessionsGroupsListParamsSchema = closedObject({});

/** One custom session group catalog entry. */
export const SessionGroupSchema = closedObject({
  name: SessionLabelString,
  position: Type.Integer({ minimum: 0 }),
});

/** New Session defaults visible only to operators who can update them. */
export const SessionGroupDefaultsSchema = closedObject({
  name: SessionLabelString,
  cwd: Type.Optional(NonEmptyString),
  worktree: Type.Optional(Type.Boolean()),
});

/** Custom session group catalog in display order. */
export const SessionsGroupsListResultSchema = closedObject({
  groups: Type.Array(SessionGroupSchema),
  sectionOrder: Type.Optional(Type.Array(SidebarSectionIdString, { maxItems: 232 })),
});

/** Reads the New Session defaults for the custom group catalog. */
export const SessionsGroupsDefaultsParamsSchema = closedObject({});

/** Write-scoped group defaults, kept separate from the read-scoped catalog. */
export const SessionsGroupsDefaultsResultSchema = closedObject({
  defaults: Type.Array(SessionGroupDefaultsSchema),
});

/** Replaces the ordered group catalog; creates listed names, keeps member categories untouched. */
export const SessionsGroupsPutParamsSchema = closedObject({
  names: Type.Array(SessionLabelString, { maxItems: 200 }),
  sectionOrder: Type.Optional(Type.Array(SidebarSectionIdString, { maxItems: 232 })),
});

/** Adds one group to the catalog if it does not already exist, appended at the end. */
export const SessionsGroupsAddParamsSchema = closedObject({
  name: SessionLabelString,
});

/**
 * Reorders the listed groups by position; unlisted groups keep their current position.
 * When sectionOrder is provided, the full sidebar section order is persisted atomically.
 */
export const SessionsGroupsReorderParamsSchema = closedObject({
  names: Type.Array(SessionLabelString, { maxItems: 200 }),
  sectionOrder: Type.Optional(Type.Array(SidebarSectionIdString, { maxItems: 232 })),
});

/** Renames a group and repoints every member session's category. */
export const SessionsGroupsRenameParamsSchema = closedObject({
  name: SessionLabelString,
  to: SessionLabelString,
});

/** Updates the New Session defaults owned by one custom group. */
export const SessionsGroupsUpdateParamsSchema = closedObject({
  name: SessionLabelString,
  cwd: Type.Union([NonEmptyString, Type.Null()]),
  worktree: Type.Boolean(),
});

/** Result after updating defaults without widening the read-scoped catalog. */
export const SessionsGroupsUpdateResultSchema = closedObject({
  ok: Type.Literal(true),
  defaults: Type.Array(SessionGroupDefaultsSchema),
});

/** Deletes a group and clears every member session's category. */
export const SessionsGroupsDeleteParamsSchema = closedObject({ name: SessionLabelString });

/** Result for group catalog mutations, with member sessions updated where applicable. */
export const SessionsGroupsMutationResultSchema = closedObject({
  ok: Type.Literal(true),
  groups: Type.Array(SessionGroupSchema),
  sectionOrder: Type.Optional(Type.Array(SidebarSectionIdString, { maxItems: 232 })),
  updatedSessions: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type SessionGroup = Static<typeof SessionGroupSchema>;
export type SessionGroupDefaults = Static<typeof SessionGroupDefaultsSchema>;
export type SessionsGroupsListParams = Static<typeof SessionsGroupsListParamsSchema>;
export type SessionsGroupsListResult = Static<typeof SessionsGroupsListResultSchema>;
export type SessionsGroupsDefaultsParams = Static<typeof SessionsGroupsDefaultsParamsSchema>;
export type SessionsGroupsDefaultsResult = Static<typeof SessionsGroupsDefaultsResultSchema>;
export type SessionsGroupsPutParams = Static<typeof SessionsGroupsPutParamsSchema>;
export type SessionsGroupsAddParams = Static<typeof SessionsGroupsAddParamsSchema>;
export type SessionsGroupsReorderParams = Static<typeof SessionsGroupsReorderParamsSchema>;
export type SessionsGroupsRenameParams = Static<typeof SessionsGroupsRenameParamsSchema>;
export type SessionsGroupsUpdateParams = Static<typeof SessionsGroupsUpdateParamsSchema>;
export type SessionsGroupsUpdateResult = Static<typeof SessionsGroupsUpdateResultSchema>;
export type SessionsGroupsDeleteParams = Static<typeof SessionsGroupsDeleteParamsSchema>;
export type SessionsGroupsMutationResult = Static<typeof SessionsGroupsMutationResultSchema>;
