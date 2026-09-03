// Wizard gateway methods manage interactive setup wizard sessions and route
// start/next/status/cancel RPCs through the wizard runtime.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
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
import {
  sanitizeWizardStepForClient,
  WizardSession,
  type WizardStep,
} from "../../wizard/session.js";
import { formatForLog } from "../ws-log.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
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
    beforePersistentEffect?: () => Promise<void>;
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

function sanitizeWizardResultForClient<T extends { step?: WizardStep }>(result: T): T {
  return result.step ? { ...result, step: sanitizeWizardStepForClient(result.step) } : result;
}

/** Resolves a live wizard session or sends the public not-found error. */
function findWizardSessionOrRespond(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId: string;
  ownerConnId?: string;
}): WizardSession | null {
  const session = params.context.findOwnedWizardSession(params.sessionId, params.ownerConnId);
  if (!session) {
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
    const flow = params.flow ?? "setup";
    const createSession = () =>
      flow === "channels"
        ? new WizardSession((prompter, _signal, wizardSession) =>
            runHostedWizard((runtime) =>
              context.channelWizardRunner(
                {
                  channel: readStringValue(params.channel),
                  onConfigured: (accounts) => wizardSession.setConfiguredAccounts(accounts),
                  // Durable effects (plugin installs, config commit) must finish
                  // even if the client cancels mid-write.
                  beforePersistentEffect: async () => wizardSession.lockCancellation(),
                },
                runtime,
                prompter,
              ),
            ),
          )
        : new WizardSession((prompter) =>
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
          );
    const session = await createAdmittedWizardSession(createSession, flow === "setup");
    if (!session) {
      respondSetupAdmissionBusy(respond);
      return;
    }
    const sessionId = context.trackWizardSession(session, client?.connId);
    if (!sessionId) {
      session.cancel();
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard session conflict"));
      return;
    }
    const result = await session.next();
    if (result.done) {
      // Let the runner release setup admission before the terminal response,
      // so an immediate replacement wizard is not rejected as still busy.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, { sessionId, ...sanitizeWizardResultForClient(result) }, undefined);
  },
  "wizard.next": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({
      context,
      respond,
      sessionId,
      ownerConnId: client?.connId,
    });
    if (!session) {
      return;
    }
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        const validationError = await session.answer(answer.stepId ?? "", answer.value);
        if (validationError) {
          respond(
            true,
            {
              ...sanitizeWizardResultForClient(await session.next()),
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
    const result = await session.next();
    if (result.done) {
      // Keep terminal response ordering identical to wizard.start.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, sanitizeWizardResultForClient(result), undefined);
  },
  "wizard.cancel": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({
      context,
      respond,
      sessionId,
      ownerConnId: client?.connId,
    });
    if (!session) {
      return;
    }
    const cancelled = session.cancel();
    const status = readWizardStatus(session);
    if (cancelled) {
      const purge = () => context.purgeWizardSession(sessionId);
      void whenAdmittedWizardSessionSettled(session).then(purge, purge);
    } else if (status.status !== "running") {
      context.purgeWizardSession(sessionId);
    }
    respond(true, status, undefined);
  },
  "wizard.status": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({
      context,
      respond,
      sessionId,
      ownerConnId: client?.connId,
    });
    if (!session) {
      return;
    }
    const status = readWizardStatus(session);
    if (status.status !== "running") {
      await whenAdmittedWizardSessionSettled(session);
    }
    context.purgeWizardSession(sessionId);
    respond(true, status, undefined);
  },
};
