import { safeParseJson } from "@openclaw/normalization-core";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
// Operator terminal gateway methods: open a PTY shell bound to the caller's
// connection, then stream input/resize/close over the same WebSocket. All
// methods require admin scope (enforced by the descriptor table); this module
// re-checks that the feature is enabled and that isolation permits a host shell.
import {
  ErrorCodes,
  errorShape,
  type TerminalOpenParams,
  type TerminalUploadResult,
  validateTerminalAttachParams,
  validateTerminalCloseParams,
  validateTerminalInputParams,
  validateTerminalOpenParams,
  validateTerminalResizeParams,
  validateTerminalUploadResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { allowsProcessHomeSessionScan } from "../../config/paths.js";
import { NODE_TERMINAL_UPLOAD_COMMAND } from "../../infra/node-commands.js";
import { mergeProcessEnv } from "../../infra/process-env.js";
import type { TerminalUploadFile } from "../../infra/terminal-file-upload.js";
import type { SessionCatalogTerminalPlan } from "../../plugins/session-catalog.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { buildTerminalEnv, type TerminalLaunchResolution } from "../terminal/launch.js";
import { createNodeRelayBackend } from "../terminal/node-relay.js";
import {
  createTerminalOpenDeadline,
  TerminalOpenDeadlineError,
  waitForTerminalOpenDeadline,
} from "../terminal/open-deadline.js";
import { resolveSessionCatalogProvider } from "./session-catalog.js";
import {
  authorizeCatalogTerminalNode,
  authorizeTerminalNodeCommand,
  resolveTerminalOpenSpawnPlan,
} from "./terminal-open-plan.js";
import { terminalUploadHandlers } from "./terminal-upload.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function invalid(respond: GatewayRequestHandlerOptions["respond"], detail: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail));
}

function requireConnId(opts: GatewayRequestHandlerOptions): string | null {
  const connId = opts.client?.connId;
  if (!connId) {
    invalid(opts.respond, "terminal requires an authenticated connection");
    return null;
  }
  return connId;
}

function terminalEnabled(context: GatewayRequestHandlerOptions["context"]): boolean {
  return context.isTerminalEnabled();
}

export { TERMINAL_OPEN_DEADLINE_MS } from "../terminal/open-deadline.js";

function terminalFailureMessage(message: string, hint?: string): string {
  return hint ? `${message}; ${hint}` : message;
}

function respondTerminalOpenTimeout(
  respond: GatewayRequestHandlerOptions["respond"],
  hint?: string,
): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, terminalFailureMessage("terminal open timed out", hint)),
  );
}

function parseNodePayload(payload: unknown, payloadJSON?: string | null): unknown {
  if (!payloadJSON) {
    return payload;
  }
  return safeParseJson(payloadJSON);
}

async function stageNodeTerminalUpload(
  context: GatewayRequestHandlerOptions["context"],
  nodeId: string,
  file: TerminalUploadFile,
): Promise<TerminalUploadResult> {
  const access = authorizeTerminalNodeCommand(context, nodeId, NODE_TERMINAL_UPLOAD_COMMAND);
  if (!access.ok) {
    throw new Error(access.message);
  }
  const result = await context.nodeRegistry.invoke({
    nodeId,
    expectedConnId: access.node.connId,
    ...(access.node.pairingGeneration
      ? { expectedPairingGeneration: access.node.pairingGeneration }
      : {}),
    command: NODE_TERMINAL_UPLOAD_COMMAND,
    params: file,
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(result.error?.message ?? "terminal node upload failed");
  }
  const payload = parseNodePayload(result.payload, result.payloadJSON);
  if (!validateTerminalUploadResult(payload)) {
    throw new Error("terminal node returned an invalid upload result");
  }
  return payload as TerminalUploadResult;
}

function respondLaunchBlocked(
  respond: GatewayRequestHandlerOptions["respond"],
  block: Extract<TerminalLaunchResolution, { ok: false }>["block"],
  hint?: string,
): void {
  if (block.kind === "disabled") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, terminalFailureMessage("terminal is disabled", hint)),
    );
    return;
  }
  if (block.kind === "unknown-agent") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        terminalFailureMessage(`unknown agent "${block.agentId}"`, hint),
      ),
    );
    return;
  }
  if (block.kind === "owner-required") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, terminalFailureMessage(block.message, hint)),
    );
    return;
  }
  // Fail closed: a sandboxed agent must never receive a host shell.
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      terminalFailureMessage(
        `terminal unavailable: agent "${block.agentId}" runs in a sandbox (mode "${block.mode}"); in-sandbox terminals are not supported yet`,
        hint,
      ),
    ),
  );
}

// A start RPC has no emulator dimensions yet. Match the Control UI's existing
// fallback grid; terminal.resize replaces it once the new tab is mounted.
export const CATALOG_TERMINAL_INITIAL_SIZE = { cols: 80, rows: 24 } as const;

type TerminalSessionOpenRequest = {
  agentId?: string;
  sessionKey?: string;
  cols: number;
  rows: number;
  requiredCwd?: string;
  resolveCatalogPlan?: (agentId: string) => Promise<SessionCatalogTerminalPlan>;
  catalogFailureMessage?: string;
  failureHint?: string;
};

/** Canonical terminal admission and launch path shared by shell, resume, and start RPCs. */
export async function openTerminalSession(
  opts: GatewayRequestHandlerOptions,
  request: TerminalSessionOpenRequest,
): Promise<void> {
  const { respond, context } = opts;
  const connId = requireConnId(opts);
  if (!connId) {
    return;
  }
  const manager = context.terminalSessions;
  if (!manager) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal is not available", request.failureHint),
      ),
    );
    return;
  }
  const launch = context.resolveTerminalLaunchPolicy(request.agentId);
  if (!launch.ok) {
    respondLaunchBlocked(respond, launch.block, request.failureHint);
    return;
  }
  const deadline = createTerminalOpenDeadline();

  let catalogPlan: SessionCatalogTerminalPlan | undefined;
  let title: string | undefined;
  let createBackend: (() => ReturnType<typeof createNodeRelayBackend>) | undefined;
  let nodeRelay:
    | {
        plan: Extract<SessionCatalogTerminalPlan, { kind: "node" }>;
        params: Record<string, unknown>;
      }
    | undefined;
  let stageUpload: ((file: TerminalUploadFile) => Promise<TerminalUploadResult>) | undefined;
  if (request.resolveCatalogPlan) {
    const resolveCatalogPlan = request.resolveCatalogPlan;
    try {
      catalogPlan = await waitForTerminalOpenDeadline(
        () => resolveCatalogPlan(launch.plan.agentId),
        deadline,
      );
    } catch (error) {
      if (error instanceof TerminalOpenDeadlineError) {
        respondTerminalOpenTimeout(respond, request.failureHint);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error
            ? terminalFailureMessage(error.message, request.failureHint)
            : terminalFailureMessage(
                request.catalogFailureMessage ?? "catalog terminal open failed",
                request.failureHint,
              ),
        ),
      );
      return;
    }
    title = catalogPlan.title;
    if (catalogPlan.kind === "local") {
      if (catalogPlan.argv.length === 0) {
        invalid(
          respond,
          terminalFailureMessage("catalog terminal plan has no command", request.failureHint),
        );
        return;
      }
    } else {
      const nodeCatalogPlan = catalogPlan;
      const access = authorizeCatalogTerminalNode(context, nodeCatalogPlan);
      if (!access.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            terminalFailureMessage(access.message, request.failureHint),
          ),
        );
        return;
      }
      let nodeParams: Record<string, unknown>;
      try {
        const parsed = JSON.parse(catalogPlan.paramsJSON) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalid params");
        }
        nodeParams = {
          ...(parsed as Record<string, unknown>),
          cols: request.cols,
          rows: request.rows,
        };
      } catch {
        invalid(
          respond,
          terminalFailureMessage("catalog terminal plan has invalid params", request.failureHint),
        );
        return;
      }
      let policyResult: Awaited<ReturnType<typeof applyPluginNodeInvokePolicy>>;
      try {
        policyResult = await waitForTerminalOpenDeadline(
          () =>
            applyPluginNodeInvokePolicy({
              context,
              client: opts.client,
              nodeSession: access.node,
              command: nodeCatalogPlan.command,
              params: nodeParams,
            }),
          deadline,
        );
      } catch (error) {
        if (error instanceof TerminalOpenDeadlineError) {
          respondTerminalOpenTimeout(respond, request.failureHint);
          return;
        }
        throw error;
      }
      if (policyResult && !policyResult.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            terminalFailureMessage(policyResult.message, request.failureHint),
          ),
        );
        return;
      }
      nodeRelay = { plan: nodeCatalogPlan, params: nodeParams };
      stageUpload = async (file) =>
        await stageNodeTerminalUpload(context, nodeCatalogPlan.nodeId, file);
    }
  }

  if (context.isConnectionActive?.(connId) === false) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal connection closed", request.failureHint),
      ),
    );
    return;
  }
  if (!terminalEnabled(context)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal is disabled", request.failureHint),
      ),
    );
    return;
  }
  const refreshedLaunch = context.resolveTerminalLaunchPolicy(request.agentId);
  if (!refreshedLaunch.ok) {
    respondLaunchBlocked(respond, refreshedLaunch.block, request.failureHint);
    return;
  }
  let agentSessionKey: string | undefined;
  if (request.sessionKey) {
    const runtimeConfig = context.getRuntimeConfig();
    const requestedOwner = resolveRequestedSessionAgentId(
      runtimeConfig,
      request.sessionKey,
      refreshedLaunch.plan.agentId,
    );
    if (!requestedOwner.ok) {
      respond(false, undefined, requestedOwner.error);
      return;
    }
    agentSessionKey = resolveStoredSessionKeyForAgentStore({
      cfg: runtimeConfig,
      agentId: requestedOwner.agentId,
      sessionKey: request.sessionKey,
    });
  }
  if (nodeRelay) {
    const relay = nodeRelay;
    const access = authorizeCatalogTerminalNode(context, relay.plan);
    if (!access.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          terminalFailureMessage(access.message, request.failureHint),
        ),
      );
      return;
    }
    createBackend = async () =>
      await createNodeRelayBackend({
        registry: context.nodeRegistry,
        nodeId: relay.plan.nodeId,
        expectedConnId: access.node.connId,
        expectedPairingGeneration: access.node.pairingGeneration,
        command: relay.plan.command,
        params: relay.params,
      });
  }
  const spawnPlan = resolveTerminalOpenSpawnPlan(refreshedLaunch.plan, catalogPlan);
  if (request.requiredCwd !== undefined && spawnPlan.cwd !== request.requiredCwd) {
    invalid(
      respond,
      terminalFailureMessage(
        "cwd is no longer available; recreate or choose the worktree and retry",
        request.failureHint,
      ),
    );
    return;
  }
  const terminalEnv =
    catalogPlan?.kind === "local"
      ? mergeProcessEnv([
          buildTerminalEnv(process.env),
          catalogPlan.env,
          // Preserve the PATH that found a login-shell CLI so env-based shebangs
          // can resolve their interpreter inside the spawned terminal process.
          catalogPlan.pathEnv ? { PATH: catalogPlan.pathEnv } : undefined,
        ])
      : buildTerminalEnv(process.env);
  const closeOpenedSession = (sessionId: string) =>
    agentSessionKey
      ? manager.closeAgent(agentSessionKey, sessionId, spawnPlan.agentId)
      : manager.close(connId, sessionId);
  let openingTerminal: ReturnType<typeof manager.open> | undefined;
  let outcome: Awaited<ReturnType<typeof manager.open>>;
  try {
    outcome = await waitForTerminalOpenDeadline(() => {
      openingTerminal = manager.open({
        owner: agentSessionKey
          ? { kind: "agent", agentSessionKey, agentId: spawnPlan.agentId }
          : { kind: "conn", connId },
        ...(agentSessionKey ? { viewerConnId: connId } : {}),
        agentId: spawnPlan.agentId,
        cwd: spawnPlan.cwd,
        shell: spawnPlan.shell,
        args: spawnPlan.args,
        cols: request.cols,
        rows: request.rows,
        env: terminalEnv,
        signal: deadline.controller.signal,
        ...(createBackend ? { createBackend } : {}),
        ...(stageUpload ? { stageUpload } : {}),
      });
      return openingTerminal;
    }, deadline);
  } catch (error) {
    if (error instanceof TerminalOpenDeadlineError) {
      // The backend can register immediately before deadline arbitration.
      // Close a late success by id so timeout never leaves an unreachable PTY.
      if (openingTerminal) {
        void openingTerminal.then(
          (lateOutcome) => {
            if (lateOutcome.ok) {
              closeOpenedSession(lateOutcome.sessionId);
            }
          },
          () => undefined,
        );
      }
      respondTerminalOpenTimeout(respond, request.failureHint);
      return;
    }
    throw error;
  }
  if (!outcome.ok) {
    const code = outcome.code === "limit" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
    respond(
      false,
      undefined,
      errorShape(code, terminalFailureMessage(outcome.message, request.failureHint)),
    );
    return;
  }
  if (context.isConnectionActive?.(connId) === false) {
    // A browser deadline can close the socket while PTY creation is still
    // finishing. Release the raced session instead of leaving an orphan.
    closeOpenedSession(outcome.sessionId);
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        terminalFailureMessage("terminal connection closed", request.failureHint),
      ),
    );
    return;
  }
  context.logGateway.info(
    `terminal opened session=${outcome.sessionId} agent=${outcome.agentId} conn=${connId} shell=${outcome.shell}`,
  );
  respond(true, {
    sessionId: outcome.sessionId,
    agentId: outcome.agentId,
    shell: outcome.shell,
    cwd: outcome.cwd,
    confined: false,
    ...(title ? { title } : {}),
  });
}

/** Handlers for the operator terminal method family. */
export const terminalHandlers: GatewayRequestHandlers = {
  ...terminalUploadHandlers,
  "terminal.open": async (opts) => {
    const { params, respond } = opts;
    if (!assertValidParams(params, validateTerminalOpenParams, "terminal.open", respond)) {
      return;
    }
    const p = params as TerminalOpenParams;
    let resolveCatalogPlan: ((agentId: string) => Promise<SessionCatalogTerminalPlan>) | undefined;
    if (p.catalog) {
      const provider = resolveSessionCatalogProvider(p.catalog.catalogId);
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${p.catalog.catalogId}`),
        );
        return;
      }
      if (!provider.openTerminal) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "session catalog cannot open terminals"),
        );
        return;
      }
      const openTerminal = provider.openTerminal;
      const catalog = p.catalog;
      resolveCatalogPlan = async (agentId) =>
        await openTerminal.call(provider, {
          allowProcessHomeFallback: allowsProcessHomeSessionScan(),
          agentId,
          hostId: catalog.hostId,
          threadId: catalog.threadId,
        });
    }
    await openTerminalSession(opts, {
      ...(p.agentId ? { agentId: p.agentId } : {}),
      ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}),
      cols: p.cols,
      rows: p.rows,
      ...(resolveCatalogPlan ? { resolveCatalogPlan } : {}),
      catalogFailureMessage: "catalog terminal open failed",
    });
  },

  "terminal.input": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalInputParams, "terminal.input", respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string; data: string };
    // Defense-in-depth for an RCE-class surface: disabling the terminal
    // restarts the gateway, but the runtime config snapshot flips first, so
    // re-checking here cuts keystrokes to live PTYs before the restart lands.
    if (!terminalEnabled(context)) {
      context.terminalSessions?.close(connId, p.sessionId);
      respond(true, { ok: false });
      return;
    }
    const ok = context.terminalSessions?.write(connId, p.sessionId, p.data) ?? false;
    respond(true, { ok });
  },

  "terminal.resize": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalResizeParams, "terminal.resize", respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string; cols: number; rows: number };
    if (!terminalEnabled(context)) {
      context.terminalSessions?.close(connId, p.sessionId);
      respond(true, { ok: false });
      return;
    }
    const ok = context.terminalSessions?.resize(connId, p.sessionId, p.cols, p.rows) ?? false;
    respond(true, { ok });
  },

  "terminal.close": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalCloseParams, "terminal.close", respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string };
    const ok = context.terminalSessions?.close(connId, p.sessionId) ?? false;
    respond(true, { ok });
  },

  "terminal.attach": async (opts) => {
    const { params, respond, context } = opts;
    if (!assertValidParams(params, validateTerminalAttachParams, "terminal.attach", respond)) {
      return;
    }
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    const p = params as { sessionId: string };
    // Same defense-in-depth as input/resize: the disable restart may still be
    // in flight, so refuse handing a live PTY stream to a new connection.
    if (!context.terminalSessions || !terminalEnabled(context)) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "terminal is not available"));
      return;
    }
    const attached = context.terminalSessions.attach(connId, p.sessionId);
    if (!attached) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown terminal session "${p.sessionId}"`),
      );
      return;
    }
    context.logGateway.info(
      `terminal attached session=${attached.sessionId} agent=${attached.agentId} conn=${connId}`,
    );
    const supportsOffsetSeq = hasGatewayClientCap(
      opts.client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
    );
    respond(true, {
      sessionId: attached.sessionId,
      agentId: attached.agentId,
      shell: attached.shell,
      cwd: attached.cwd,
      confined: false,
      buffer: attached.buffer,
      ...(supportsOffsetSeq ? { seq: attached.seq } : {}),
    });
  },

  "terminal.list": async (opts) => {
    const { respond, context } = opts;
    const connId = requireConnId(opts);
    if (!connId) {
      return;
    }
    // An empty list (not an error) when the surface is off/unwired keeps the
    // reconnect flow simple: clients just fall back to opening fresh sessions.
    const sessions =
      context.terminalSessions && terminalEnabled(context)
        ? context.terminalSessions.list().map((session) => ({
            sessionId: session.sessionId,
            agentId: session.agentId,
            shell: session.shell,
            cwd: session.cwd,
            // Mirrors terminal.open: only unconfined host shells exist today.
            confined: false,
            attached: session.attached,
            owner: session.owner,
            createdAtMs: session.createdAtMs,
          }))
        : [];
    respond(true, { sessions });
  },
};
