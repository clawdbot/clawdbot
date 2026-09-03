import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import { resolveManifestProviderAuthChoice } from "../../plugins/provider-auth-choices.js";
import { isProviderLoginChoiceStartable } from "../../plugins/provider-login-options.js";
import { refreshModelAuthStateAfterMutation } from "./models-auth-status.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { gatewayWizardStepRuntime, startGatewayWizardSession } from "./wizard-session-start.js";

const PROVIDER_LOGIN_SESSION_TIMEOUT_MS = 25 * 60 * 1000;

export async function startModelsAuthLoginWizard(params: {
  authChoice: string;
  agentId?: string;
  sessionId: string;
  context: GatewayRequestContext;
  respond: RespondFn;
  ownerConnId?: string;
  /** The starting request's abort signal; a disconnect before persistence cancels the login. */
  requestSignal?: AbortSignal;
}): Promise<void> {
  const config = params.context.getRuntimeConfig();
  const choice = resolveManifestProviderAuthChoice(params.authChoice, {
    config,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  if (!choice || !isProviderLoginChoiceStartable(choice)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "That provider login is not available on this Gateway. Refresh Models and choose an available sign-in option.",
      ),
    );
    return;
  }
  const loginSession = await startGatewayWizardSession({
    context: params.context,
    respond: params.respond,
    sessionId: params.sessionId,
    ...(params.ownerConnId ? { ownerConnId: params.ownerConnId } : {}),
    timeoutMs: PROVIDER_LOGIN_SESSION_TIMEOUT_MS,
    run: async (prompter, signal, session) => {
      const result = await runModelsAuthLoginFlowCore({
        provider: choice.providerId,
        method: choice.methodId,
        ownerPluginId: choice.pluginId,
        credentialOnly: true,
        setDefault: config.agents?.defaults?.model === undefined,
        ...(params.agentId ? { agent: params.agentId } : {}),
        config,
        runtime: gatewayWizardStepRuntime,
        prompter,
        signal,
        isRemote: true,
        openUrl: async (url) => await prompter.openUrl?.(url),
        beforePersistentEffect: () => {
          signal.throwIfAborted();
          session.lockCancellation();
        },
        refreshAuthState: async () => {
          await refreshModelAuthStateAfterMutation(params.context, "login");
          return "refreshed";
        },
      });
      if (result.profiles.length === 0) {
        throw new Error(`${choice.choiceLabel} did not return a credential profile.`);
      }
      if (result.modelAccess === "failed") {
        throw new Error(
          `${choice.choiceLabel} sign-in succeeded, but OpenClaw could not enable its models. Retry after the current config change finishes.`,
        );
      }
      if (result.defaultModel) {
        session.setModelActivation({ modelRef: result.defaultModel });
      }
    },
  });
  if (!loginSession || !params.requestSignal) {
    return;
  }
  const cancel = () => loginSession.session.cancel();
  params.requestSignal.addEventListener("abort", cancel, { once: true });
  try {
    if (params.requestSignal.aborted) {
      cancel();
    }
    await loginSession.session.whenSettled();
  } finally {
    params.requestSignal.removeEventListener("abort", cancel);
    if (params.requestSignal.aborted) {
      params.context.purgeWizardSession(loginSession.sessionId);
    }
  }
}
