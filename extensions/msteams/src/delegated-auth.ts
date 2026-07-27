import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export const MSTEAMS_DELEGATED_AUTH_PROVIDER = "msteams";
type OpenClawPluginAuthContext = NonNullable<OpenClawPluginToolContext["auth"]>;
type DelegatedAccessTokenResult = Awaited<
  ReturnType<OpenClawPluginAuthContext["getDelegatedAccessToken"]>
>;

export function createMSTeamsDelegatedAuthContext(params: {
  context: MSTeamsTurnContext;
  connectionName?: string;
  onDebug?: (message: string, meta?: Record<string, unknown>) => void;
}): OpenClawPluginAuthContext | undefined {
  const connectionName = params.connectionName?.trim();
  if (!connectionName || typeof params.context.signin !== "function") {
    return undefined;
  }

  const signin = params.context.signin.bind(params.context);
  const tenantId =
    params.context.activity.channelData?.tenant?.id ??
    params.context.activity.conversation?.tenantId;
  const userId =
    params.context.activity.from?.aadObjectId?.trim() ||
    params.context.activity.from?.id?.trim() ||
    undefined;
  let tokenResult: Promise<DelegatedAccessTokenResult> | undefined;

  return {
    getDelegatedAccessToken: async (request) => {
      if (request.provider !== MSTEAMS_DELEGATED_AUTH_PROVIDER) {
        return { ok: false, reason: "not_configured" };
      }
      const requestedConnectionName = request.connectionName?.trim();
      if (requestedConnectionName && requestedConnectionName !== connectionName) {
        return { ok: false, reason: "not_configured" };
      }

      tokenResult ??= signin({
        connectionName,
        oauthCardText:
          "Sign in to allow OpenClaw to use your Microsoft Teams delegated access for this tool.",
        signInButtonText: "Sign in",
      })
        .then((token) =>
          token
            ? {
                ok: true as const,
                token,
                ...(tenantId ? { tenantId } : {}),
                ...(userId ? { userId } : {}),
              }
            : { ok: false as const, reason: "missing_consent" as const },
        )
        .catch((error: unknown) => {
          params.onDebug?.("msteams delegated auth signin failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return { ok: false as const, reason: "unavailable" as const };
        });
      return tokenResult;
    },
  };
}
