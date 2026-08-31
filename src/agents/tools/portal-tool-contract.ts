import { Type } from "typebox";
import {
  PortalCloseResultSchema,
  PortalListResultSchema,
  PortalSummarySchema,
} from "../../../packages/gateway-protocol/src/schema/portals.js";

export const PORTAL_TOOL_DESCRIPTION =
  "Expose local HTTP server; operator sees it live in Control UI. Order matters: action=open with the port first, which returns the URL; then start the dev server as a background process, passing PORT and PUBLIC_URL from that result. Workspace may declare servers in .openclaw/portals.json. Proxies HTTP and WebSockets, so hot reload works; serves retry page until port listens. action=list and action=close manage portals. Portals end at gateway restart.";

export const PortalToolSchema = Type.Object(
  {
    action: Type.String({ enum: ["open", "list", "close"], description: "Portal action" }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
    path: Type.Optional(Type.String({ pattern: "^/" })),
    id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const PortalOutputSchema = Type.Union([
  PortalSummarySchema,
  PortalListResultSchema,
  PortalCloseResultSchema,
]);
