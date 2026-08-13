import { Type } from "typebox";
import {
  PortalCloseResultSchema,
  PortalListResultSchema,
  PortalSummarySchema,
  type PortalCloseResult,
  type PortalListResult,
  type PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AgentToolResult } from "../runtime/index.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const PORTAL_ACTIONS = ["open", "list", "close"] as const;

const PortalToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...PORTAL_ACTIONS], description: "Portal action" }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
    path: Type.Optional(Type.String({ pattern: "^/" })),
    id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const PortalToolOutputSchema = Type.Union([
  PortalSummarySchema,
  PortalListResultSchema,
  PortalCloseResultSchema,
]);

type PortalToolOptions = {
  callGateway?: InProcessGatewayCaller;
};

function portalResult<T>(text: string, payload: T): AgentToolResult<T> {
  const result = jsonResult(payload);
  return { ...result, content: [{ type: "text", text }, ...result.content] };
}

export function createPortalTool(options: PortalToolOptions = {}): AnyAgentTool {
  const callGateway = options.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Portal",
    name: "portal",
    description:
      "Expose local HTTP server; operator sees it live in Control UI. Order matters: action=open with the port first, which returns the URL; then start the dev server as a background process, passing PORT and PUBLIC_URL from that result. Workspace may declare servers in .openclaw/portals.json. Proxies HTTP and WebSockets, so hot reload works; serves retry page until port listens. action=list and action=close manage portals. Portals end at gateway restart.",
    parameters: PortalToolSchema,
    outputSchema: PortalToolOutputSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (action === "list") {
        const result = await callGateway<PortalListResult>("portal.list", {});
        return portalResult(
          `${result.portals.length} active portal${result.portals.length === 1 ? "" : "s"}. The operator can see them in the Control UI Portals page.`,
          result,
        );
      }
      if (action === "close") {
        const id = readToolStringParam(params, "id", { required: true });
        const result = await callGateway<PortalCloseResult>("portal.close", { id });
        return portalResult(
          `Portal ${id} closed. The Control UI Portals page has been updated.`,
          result,
        );
      }
      if (action !== "open") {
        throw new ToolInputError(`Unknown portal action: ${action}`);
      }
      const port = readPositiveIntegerParam(params, "port", {
        max: 65_535,
        message: "port must be an integer from 1 to 65535",
      });
      if (port === undefined) {
        throw new ToolInputError("port required");
      }
      const title = readToolStringParam(params, "title");
      const description = readToolStringParam(params, "description", { allowEmpty: true });
      const path = readToolStringParam(params, "path");
      if (path !== undefined && !path.startsWith("/")) {
        throw new ToolInputError("path must start with /");
      }
      const portal = await callGateway<PortalSummary>("portal.open", {
        port,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(path !== undefined ? { path } : {}),
      });
      return portalResult(
        `Portal available at ${portal.url}. Pass PUBLIC_URL=${portal.publicUrl} and PORT=${portal.port} when starting the dev server. The operator can see it in the Control UI Portals page.`,
        portal,
      );
    },
  };
}
