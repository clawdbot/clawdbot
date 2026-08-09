import { statSync } from "node:fs";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type SessionsCatalogStartTerminalParams,
  validateSessionsCatalogStartTerminalParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type SessionCatalogProviderResolver = (catalogId: string) => SessionCatalogProvider | undefined;
type SessionCatalogCreateTargetResolver = (
  catalogId: string,
  agentId: string,
  config: OpenClawConfig,
) => { ok: true } | { ok: false; message: string };

/** Builds the catalog terminal-start handler around the active provider registry. */
export function catalogStartHandler(
  resolveProvider: SessionCatalogProviderResolver,
  resolveCreateTarget: SessionCatalogCreateTargetResolver,
): GatewayRequestHandlers["sessions.catalog.startTerminal"] {
  return async (opts) => {
    const { params, respond, context } = opts;
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogStartTerminalParams,
        "sessions.catalog.startTerminal",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogStartTerminalParams;
    const config = context.getRuntimeConfig();
    if (config.gateway?.cliAgents?.enabled !== true) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "CLI agent terminal start is disabled; enable gateway.cliAgents.enabled and retry",
        ),
      );
      return;
    }
    if (!context.isTerminalEnabled()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "terminal is disabled; enable gateway.terminal.enabled and retry",
        ),
      );
      return;
    }
    if (!context.terminalSessions) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "terminal is not available; restart the Gateway with terminal support and retry",
        ),
      );
      return;
    }
    const provider = resolveProvider(request.catalogId);
    if (!provider) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${request.catalogId}`),
      );
      return;
    }
    if (!provider.startTerminalSession) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "session catalog cannot start terminal sessions; choose a catalog that advertises createSession.startTerminal",
        ),
      );
      return;
    }
    const createTarget = resolveCreateTarget(request.catalogId, request.agentId, config);
    if (!createTarget.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, createTarget.message));
      return;
    }
    let nodeId: string | undefined;
    if (request.hostId && request.hostId !== "gateway:local") {
      nodeId = request.hostId.startsWith("node:")
        ? request.hostId.slice("node:".length).trim()
        : undefined;
      if (!nodeId || request.hostId !== `node:${nodeId}`) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'invalid catalog host; choose "gateway:local" or a listed "node:<id>" host and retry',
          ),
        );
        return;
      }
    }
    if (!nodeId) {
      let cwdIsDirectory = false;
      try {
        cwdIsDirectory = path.isAbsolute(request.cwd) && statSync(request.cwd).isDirectory();
      } catch {
        // The caller owns worktree provisioning; missing/unreadable paths must not fall back home.
      }
      if (!cwdIsDirectory) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "cwd must be an existing absolute directory; create or choose a worktree and retry",
          ),
        );
        return;
      }
    }
    const startTerminalSession = provider.startTerminalSession;
    const { openTerminalSession, CATALOG_TERMINAL_INITIAL_SIZE } = await import("./terminal.js");
    await openTerminalSession(opts, {
      agentId: request.agentId,
      ...CATALOG_TERMINAL_INITIAL_SIZE,
      ...(!nodeId ? { requiredCwd: request.cwd } : {}),
      failureHint: "check the selected CLI, host, and terminal configuration, then retry",
      resolveCatalogPlan: async () => {
        const plan = await startTerminalSession.call(provider, {
          agentId: request.agentId,
          cwd: request.cwd,
          ...(request.initialMessage !== undefined
            ? { initialMessage: request.initialMessage }
            : {}),
          ...(nodeId ? { nodeId } : {}),
        });
        if (plan.cwd !== request.cwd) {
          throw new Error(
            "session catalog did not preserve the requested cwd; choose the worktree again and retry",
          );
        }
        if (nodeId && (plan.kind !== "node" || plan.nodeId !== nodeId)) {
          throw new Error(
            "session catalog cannot start on the selected node; choose a supported host and retry",
          );
        }
        if (!nodeId && plan.kind !== "local") {
          throw new Error(
            'session catalog returned a remote plan for the local host; select its "node:<id>" host and retry',
          );
        }
        return plan;
      },
      catalogFailureMessage: "catalog terminal start failed",
    });
  };
}
