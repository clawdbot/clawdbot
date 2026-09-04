import * as portals from "./portals.js";

export const PortalProtocolSchemas = {
  PortalSummary: portals.PortalSummarySchema,
  PortalListParams: portals.PortalListParamsSchema,
  PortalListResult: portals.PortalListResultSchema,
  PortalOpenParams: portals.PortalOpenParamsSchema,
  PortalOpenResult: portals.PortalOpenResultSchema,
  PortalCloseParams: portals.PortalCloseParamsSchema,
  PortalCloseResult: portals.PortalCloseResultSchema,
  PortalChangedEvent: portals.PortalChangedEventSchema,
} as const;
