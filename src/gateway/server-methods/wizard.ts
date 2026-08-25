// Wizard gateway methods manage interactive setup wizard sessions and route
// start/next/status/cancel RPCs through the wizard runtime.
import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import { createNonExitingRuntime, ExitError, type RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardClientCapabilityError, WizardSession } from "../../wizard/session.js";
import { formatForLog } from "../ws-log.js";
import { resolveGatewaySessionOwnerKey } from "./gateway-session-owner.js";
import {
  createAdmittedWizardSession,
  SETUP_ADMISSION_BUSY_MESSAGE,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

export type SetupWizardRunner = (
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export type ChannelSetupWizardRunner = (
  opts: {
    channel?: string;
    onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
    beforeExternalEffect?: () => Promise<void>;
    beforePersistentEffect?: () => Promise<void>;
    signal?: AbortSignal;
  },
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../../wizard/setup.js");
  return runSetupWizard(...args);
};

export const runDefaultChannelSetupWizard: ChannelSetupWizardRunner = async (...args) => {
  const { runChannelsSetupWizard } = await import("../../commands/channels/add-wizard.js");
  return runChannelsSetupWizard(...args);
};

async function runHostedWizard(run: (runtime: RuntimeEnv) => Promise<void>): Promise<void> {
  try {
    await run(createNonExitingRuntime());
  } catch (error) {
    // Hosted wizards share the Gateway process; a successful CLI-style exit
    // must complete only its session, while failures remain session errors.
    if (error instanceof ExitError && error.code === 0) {
      return;
    }
    throw error;
  }
}

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

async function readWizardResultForClient(params: {
  session: WizardSession;
  supportsQrCode: boolean;
  respond: RespondFn;
}) {
  try {
    while (true) {
      const result = await params.session.next({ supportsQrCode: params.supportsQrCode });
      if (!result.step) {
        return result;
      }
      const step = params.session.projectStepForClient(result.step);
      if (step) {
        return { ...result, step };
      }
    }
  } catch (error) {
    if (error instanceof WizardClientCapabilityError) {
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return null;
    }
    throw error;
  }
}

/** Resolves a live wizard session or sends the public not-found error. */
function findWizardSessionOrRespond(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  respond: RespondFn;
  sessionId: string;
}): WizardSession | null {
  const session = params.context.wizardSessions.get(params.sessionId);
  if (!session || !session.isOwnedBy(resolveGatewaySessionOwnerKey(params.client))) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found", {
        details: { code: GatewayErrorDetailCodes.WIZARD_NOT_FOUND },
      }),
    );
    return null;
  }
  return session;
}

/** Gateway handlers for the interactive setup wizard session lifecycle. */
export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const ownerKey = resolveGatewaySessionOwnerKey(client);
    if (!ownerKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wizard caller identity unavailable"),
      );
      return;
    }
    const sessionId = randomUUID();
    const flow = params.flow ?? "setup";
    const supportsQrCode = hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.WIZARD_QR);
    const createSession = () =>
      flow === "channels"
        ? new WizardSession(
            (prompter, signal, wizardSession) =>
              runHostedWizard((runtime) =>
                context.channelWizardRunner(
                  {
                    channel: readStringValue(params.channel),
                    onConfigured: (accounts) => wizardSession.setConfiguredAccounts(accounts),
                    // External setup effects remain cancellable until their
                    // producer settles and the session owns the commit point.
                    beforeExternalEffect: async () => signal.throwIfAborted(),
                    // Durable effects (plugin installs, config commit) must finish
                    // even if the client cancels mid-write.
                    beforePersistentEffect: async () => wizardSession.lockCancellation(),
                    signal,
                  },
                  runtime,
                  prompter,
                ),
              ),
            { supportsQrCode, ownerKey },
          )
        : new WizardSession(
            (prompter) =>
              runHostedWizard((runtime) =>
                context.wizardRunner(
                  {
                    mode: params.mode,
                    workspace: readStringValue(params.workspace),
                    installDaemon: params.installDaemon,
                  },
                  runtime,
                  prompter,
                ),
              ),
            { supportsQrCode, ownerKey },
          );
    const session = await createAdmittedWizardSession(createSession, flow === "setup");
    if (!session) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, SETUP_ADMISSION_BUSY_MESSAGE, { retryable: true }),
      );
      return;
    }
    context.wizardSessions.set(sessionId, session);
    const result = await readWizardResultForClient({ session, supportsQrCode, respond });
    if (!result) {
      return;
    }
    if (result.done) {
      // Let the runner release setup admission before the terminal response,
      // so an immediate replacement wizard is not rejected as still busy.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, { sessionId, ...result }, undefined);
  },
  "wizard.next": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const supportsQrCode = hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.WIZARD_QR);
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        const validationError = await session.answer(answer.stepId ?? "", answer.value);
        if (validationError) {
          const result = await readWizardResultForClient({
            session,
            supportsQrCode,
            respond,
          });
          if (!result) {
            return;
          }
          respond(
            true,
            {
              ...result,
              error: validationError,
            },
            undefined,
          );
          return;
        }
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    const result = await readWizardResultForClient({ session, supportsQrCode, respond });
    if (!result) {
      return;
    }
    if (result.done) {
      // Keep terminal response ordering identical to wizard.start.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, result, undefined);
  },
  "wizard.cancel": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const cancelled = session.cancel();
    const status = readWizardStatus(session);
    if (cancelled) {
      const purge = () => context.purgeWizardSession(sessionId);
      void whenAdmittedWizardSessionSettled(session).then(purge, purge);
    }
    respond(true, status, undefined);
  },
  "wizard.status": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, status, undefined);
  },
};
