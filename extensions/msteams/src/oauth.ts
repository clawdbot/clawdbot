import {
  buildMSTeamsAuthUrl,
  generateOAuthState,
  generatePkce,
  parseCallbackInput,
  shouldUseManualOAuthFlow,
  waitForLocalCallback,
} from "./oauth.flow.js";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_CALLBACK_PORT,
  type MSTeamsDelegatedOAuthContext,
  type MSTeamsDelegatedTokens,
} from "./oauth.shared.js";
import { exchangeMSTeamsCodeForTokens } from "./oauth.token.js";

export type { MSTeamsDelegatedOAuthContext, MSTeamsDelegatedTokens };

export async function loginMSTeamsDelegated(
  ctx: MSTeamsDelegatedOAuthContext,
  params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    scopes?: readonly string[];
  },
): Promise<MSTeamsDelegatedTokens> {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const needsManual = shouldUseManualOAuthFlow(ctx.isRemote);

  await ctx.note(
    needsManual
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, copy the redirect URL and paste it back here.",
        ].join("\n")
      : [
          "Browser will open for Microsoft authentication.",
          `Sign in to grant delegated permissions for MSTeams.`,
          `The callback will be captured automatically on localhost:${MSTEAMS_OAUTH_CALLBACK_PORT}.`,
        ].join("\n"),
    "MSTeams Delegated OAuth",
  );

  const { verifier, challenge } = generatePkce();
  const state = generateOAuthState();
  const authUrl = buildMSTeamsAuthUrl({
    tenantId: params.tenantId,
    clientId: params.clientId,
    challenge,
    state,
    scopes,
  });

  if (needsManual) {
    return manualFlow(ctx, authUrl, state, verifier, params);
  }

  ctx.progress.update("Complete sign-in in browser...");
  try {
    await ctx.openUrl(authUrl);
  } catch {
    ctx.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
  }

  try {
    const { code } = await waitForLocalCallback({
      expectedState: state,
      timeoutMs: 5 * 60 * 1000,
      onProgress: (msg) => ctx.progress.update(msg),
    });
    ctx.progress.update("Exchanging authorization code for tokens...");
    return await exchangeMSTeamsCodeForTokens({
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      code,
      verifier,
      scopes,
    });
  } catch (err) {
    // EADDRINUSE or other listen errors: fall back to manual flow
    if (
      err instanceof Error &&
      (err.message.includes("EADDRINUSE") ||
        err.message.includes("port") ||
        err.message.includes("listen"))
    ) {
      ctx.progress.update("Local callback server failed. Switching to manual mode...");
      return manualFlow(ctx, authUrl, state, verifier, params, err);
    }
    throw err;
  }
}

async function manualFlow(
  ctx: MSTeamsDelegatedOAuthContext,
  authUrl: string,
  state: string,
  verifier: string,
  params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    scopes?: readonly string[];
  },
  cause?: Error,
): Promise<MSTeamsDelegatedTokens> {
  ctx.progress.update("OAuth URL ready");
  ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
  ctx.progress.update("Waiting for you to paste the callback URL...");
  const callbackInput = await ctx.prompt("Paste the redirect URL here: ");
  const parsed = parseCallbackInput(callbackInput, state);
  if ("error" in parsed) {
    throw new Error(parsed.error, cause ? { cause } : undefined);
  }
  if (parsed.state !== state) {
    throw new Error("OAuth state mismatch - please try again", cause ? { cause } : undefined);
  }
  ctx.progress.update("Exchanging authorization code for tokens...");
  return exchangeMSTeamsCodeForTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    code: parsed.code,
    verifier,
    scopes: params.scopes,
  });
}
