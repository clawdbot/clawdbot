import {
  type CanvasDocumentViewResult,
  ErrorCodes,
  errorShape,
  validateCanvasDocumentViewParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildSandboxHostPath } from "../../agents/sandbox-host.js";
import { isCoreCanvasHostEnabled } from "../../canvas/config.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../../process/gateway-work-admission.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CANVAS_WIDGET_VIEW_MAX_BYTES = 2 * 1024 * 1024;
const CANVAS_WIDGET_UNAVAILABLE =
  "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";

export const canvasHandlers: GatewayRequestHandlers = {
  "canvas.document.view": defineValidatedGatewayMethod(
    "canvas.document.view",
    validateCanvasDocumentViewParams,
    async (invocation) => {
      const { params, context, client, respond } = invocation;
      const resolveContext = context.resolveGatewayContext;
      const methodRegistry = context.getGatewayMethodRegistry?.();
      const assertActive = () => {
        invocation.signal?.throwIfAborted();
        invocation.sessionMutationCommitGuard?.();
        if (
          !resolveContext ||
          resolveContext() !== context ||
          context.resolveGatewayContext !== resolveContext ||
          context.getGatewayMethodRegistry?.() !== methodRegistry ||
          client?.invalidated === true ||
          (client?.connId && context.isConnectionActive?.(client.connId) === false) ||
          isGatewaySubordinateWorkAdmissionClosed() ||
          !isCoreCanvasHostEnabled(context.getRuntimeConfig())
        ) {
          throw new Error(CANVAS_WIDGET_UNAVAILABLE);
        }
      };
      try {
        assertActive();
        const [document, sandboxPort] = await Promise.all([
          readCanvasDocumentHtmlSource(params.docId, { maxBytes: CANVAS_WIDGET_VIEW_MAX_BYTES }),
          context.getMcpAppSandboxPort?.() ?? context.ensureSandboxHostPort?.(),
        ]);
        // The bytes and listener must still belong to the admitted caller and Gateway.
        assertActive();
        if (
          document.cspSandbox !== "scripts" ||
          Buffer.byteLength(document.html, "utf8") > CANVAS_WIDGET_VIEW_MAX_BYTES ||
          sandboxPort === undefined
        ) {
          throw new Error(CANVAS_WIDGET_UNAVAILABLE);
        }
        const configuredOrigin = context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
        const result: CanvasDocumentViewResult = {
          html: document.html,
          sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
          sandboxPort,
          ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
        };
        respond(true, result);
      } catch {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, CANVAS_WIDGET_UNAVAILABLE));
      }
    },
  ),
};
