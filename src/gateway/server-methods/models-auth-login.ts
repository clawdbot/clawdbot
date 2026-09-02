import {
  ErrorCodes,
  errorShape,
  validateModelAuthLoginStartParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import { resolveManifestProviderAuthChoice } from "../../plugins/provider-auth-choices.js";
import { listProviderLoginOptions } from "../../plugins/provider-login-options.js";
import { defaultRuntime } from "../../runtime.js";
import { refreshModelAuthStateAfterMutation } from "./models-auth-status.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { startGatewayWizardSession } from "./wizard-session-start.js";

const PROVIDER_LOGIN_SESSION_TIMEOUT_MS = 25 * 60 * 1000;

/** Gateway handler for credential-only provider login through the shared wizard transport. */
export const handlers: GatewayRequestHandlers = {
  "models.authLogin.start": async ({ params, respond, context, client, signal: requestSignal }) => {
    if (
      !assertValidParams(
        params,
        validateModelAuthLoginStartParams,
        "models.authLogin.start",
        respond,
      )
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const choice = resolveManifestProviderAuthChoice(params.authChoice, {
      config,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
    if (!choice || listProviderLoginOptions([choice]).length !== 1) {
      respond(
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
      context,
      respond,
      ownerConnId: client?.connId,
      timeoutMs: PROVIDER_LOGIN_SESSION_TIMEOUT_MS,
      run: async (prompter, signal, session) => {
        const result = await runModelsAuthLoginFlowCore({
          provider: choice.providerId,
          method: choice.methodId,
          ownerPluginId: choice.pluginId,
          credentialOnly: true,
          ...(params.agentId ? { agent: params.agentId } : {}),
          config,
          runtime: {
            ...defaultRuntime,
            exit: (code: number | undefined): never => {
              throw new Error(`provider login exited with code ${String(code)}`);
            },
          },
          prompter,
          signal,
          isRemote: true,
          openUrl: async (url) => await prompter.openUrl?.(url),
          beforePersistentEffect: () => {
            signal.throwIfAborted();
            session.lockCancellation();
          },
          refreshAuthState: async (agentId) => {
            await refreshModelAuthStateAfterMutation(context, "login", agentId);
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
      },
    });
    if (!loginSession || !requestSignal) {
      return;
    }
    const cancel = () => loginSession.session.cancel();
    requestSignal.addEventListener("abort", cancel, { once: true });
    try {
      if (requestSignal.aborted) {
        cancel();
      }
      // Keep the transport abort owner alive after the start response. The wizard itself owns
      // the durable-effect fence: cancellation stops pre-commit work and locked work settles.
      await loginSession.session.whenSettled();
    } finally {
      requestSignal.removeEventListener("abort", cancel);
      if (requestSignal.aborted) {
        context.purgeWizardSession(loginSession.sessionId);
      }
    }
  },
};
