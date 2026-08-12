import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PortalSummarySchema = closedObject({
  id: NonEmptyString,
  title: NonEmptyString,
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  listenPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
  tokenQuery: Type.Optional(NonEmptyString),
  url: Type.Optional(NonEmptyString),
  publicUrl: NonEmptyString,
  path: Type.Optional(Type.String({ pattern: "^/" })),
  description: Type.Optional(Type.String()),
  createdAtMs: Type.Integer({ minimum: 0 }),
});

export const PortalListParamsSchema = closedObject({});
export const PortalListResultSchema = closedObject({
  portals: Type.Array(PortalSummarySchema),
});

export const PortalOpenParamsSchema = closedObject({
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  title: Type.Optional(NonEmptyString),
  description: Type.Optional(Type.String()),
  path: Type.Optional(Type.String({ pattern: "^/" })),
});
export const PortalOpenResultSchema = PortalSummarySchema;

export const PortalCloseParamsSchema = closedObject({ id: NonEmptyString });
export const PortalCloseResultSchema = closedObject({ closed: Type.Boolean() });

export const PortalChangedEventSchema = closedObject({
  portals: Type.Array(PortalSummarySchema),
});

export type PortalSummary = Static<typeof PortalSummarySchema>;
export type PortalListParams = Static<typeof PortalListParamsSchema>;
export type PortalListResult = Static<typeof PortalListResultSchema>;
export type PortalOpenParams = Static<typeof PortalOpenParamsSchema>;
export type PortalOpenResult = Static<typeof PortalOpenResultSchema>;
export type PortalCloseParams = Static<typeof PortalCloseParamsSchema>;
export type PortalCloseResult = Static<typeof PortalCloseResultSchema>;
export type PortalChangedEvent = Static<typeof PortalChangedEventSchema>;
