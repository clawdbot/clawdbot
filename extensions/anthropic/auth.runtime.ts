/** Auth execution stays deferred until a setup or doctor hook is invoked. */
import { formatCliCommand, parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  type AuthProfileStore,
  buildTokenProfileId,
  listProfilesForProvider,
  type OpenClawConfig as ProviderAuthConfig,
  type ProviderAuthResult,
  suggestOAuthProfileIdForLegacyDefault,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { upsertAuthProfileWithLockOrThrow } from "openclaw/plugin-sdk/provider-auth-api-key";
import * as claudeCliAuth from "./cli-auth-seam.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildAnthropicCliMigrationResult } from "./cli-migration.js";

const PROVIDER_ID = "anthropic";

type ProviderAuthMethodNonInteractiveValidationContext = Parameters<
  NonNullable<ProviderAuthMethod["validateNonInteractive"]>
>[0];

const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
  "Anthropic setup-token auth is supported in OpenClaw.",
  "OpenClaw prefers the native Claude CLI runtime when it is available on the host.",
  "Anthropic staff told us this OpenClaw path is allowed again.",
  `If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`,
] as const;

function normalizeAnthropicSetupTokenInput(value: string): string {
  return value.replaceAll(/\s+/g, "").trim();
}

function resolveAnthropicSetupTokenProfileId(rawProfileId?: unknown): string {
  if (typeof rawProfileId === "string") {
    const trimmed = rawProfileId.trim();
    if (trimmed.length > 0) {
      if (trimmed.startsWith(`${PROVIDER_ID}:`)) {
        return trimmed;
      }
      return buildTokenProfileId({ provider: PROVIDER_ID, name: trimmed });
    }
  }
  return `${PROVIDER_ID}:default`;
}

function resolveAnthropicSetupTokenExpiry(rawExpiresIn?: unknown): number | undefined {
  if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) {
    return undefined;
  }
  return resolveExpiresAtMsFromDurationMs(
    parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" }),
  );
}

export async function runAnthropicSetupTokenAuth(
  ctx: ProviderAuthContext,
  defaultModel: string,
): Promise<ProviderAuthResult> {
  const providedToken =
    typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0
      ? normalizeAnthropicSetupTokenInput(ctx.opts.token)
      : undefined;
  const token =
    providedToken ??
    normalizeAnthropicSetupTokenInput(
      await ctx.prompter.text({
        message: "Paste Anthropic setup-token",
        sensitive: true,
        validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value)),
      }),
    );
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);

  return {
    profiles: [
      {
        profileId,
        credential: {
          type: "token",
          provider: PROVIDER_ID,
          token,
          ...(expires ? { expires } : {}),
        },
      },
    ],
    defaultModel,
    notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES],
  };
}

export function validateAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveValidationContext,
): string | null {
  if (ctx.opts.secretInputMode === "ref") {
    ctx.runtime.error(
      "Anthropic setup-token input cannot be stored with --secret-input-mode ref. Use --secret-input-mode plaintext.",
    );
    ctx.runtime.exit(1);
    return null;
  }
  const rawToken =
    typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";
  const tokenError = validateAnthropicSetupToken(rawToken);
  if (tokenError) {
    ctx.runtime.error(
      ["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join(
        "\n",
      ),
    );
    ctx.runtime.exit(1);
    return null;
  }
  try {
    resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
  } catch (error) {
    ctx.runtime.error(
      `Invalid --token-expires-in: ${error instanceof Error ? error.message : String(error)}`,
    );
    ctx.runtime.exit(1);
    return null;
  }
  return rawToken;
}

export async function runAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  defaultModel: string,
): Promise<ProviderAuthConfig | null> {
  const rawToken = validateAnthropicSetupTokenNonInteractive(ctx);
  if (!rawToken) {
    return null;
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider: PROVIDER_ID,
      token: rawToken,
      ...(expires ? { expires } : {}),
    },
    agentDir: ctx.agentDir,
  });

  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);

  const withProfile = applyAuthProfileConfig(ctx.config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });
  const existingModelConfig =
    withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object"
      ? withProfile.agents.defaults.model
      : {};
  return {
    ...withProfile,
    agents: {
      ...withProfile.agents,
      defaults: {
        ...withProfile.agents?.defaults,
        model: {
          ...existingModelConfig,
          primary: defaultModel,
        },
      },
    },
  };
}

export function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext["config"];
  store: AuthProfileStore;
  profileId?: string;
}): string {
  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

export async function runAnthropicCliMigration(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const authStatus = claudeCliAuth.probeClaudeCliAuthStatus(
    resolveAnthropicCliAuthProbe(ctx.env ?? process.env),
  );
  if (authStatus.status !== "available") {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  return buildAnthropicCliMigrationResult(ctx.config);
}

export async function runAnthropicCliMigrationNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  runtime: ProviderAuthContext["runtime"];
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  const authStatus = claudeCliAuth.probeClaudeCliAuthStatus(
    resolveAnthropicCliAuthProbe(process.env),
  );
  if (authStatus.status !== "available") {
    const error =
      authStatus.status === "unreadable"
        ? [
            'Auth choice "anthropic-cli" could not verify the installed Claude CLI login.',
            `Run ${formatCliCommand("claude auth status")}, then retry.`,
          ]
        : [
            'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
            `Run ${formatCliCommand("claude auth login")} first.`,
          ];
    ctx.runtime.error(error.join("\n"));
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildAnthropicCliMigrationResult(ctx.config);
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;
  const migratedModel = result.configPatch?.agents?.defaults?.model;
  const migratedFallbacks =
    migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel
      ? migratedModel.fallbacks
      : undefined;
  const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;

  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          ...(Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {}),
          primary: result.defaultModel,
        },
      },
    },
  };
}

function resolveAnthropicCliAuthProbe(env: NodeJS.ProcessEnv): {
  command: string;
  env: NodeJS.ProcessEnv;
} {
  const backend = buildAnthropicCliBackend().config;
  const probeEnv = { ...env, ...backend.env };
  for (const name of backend.clearEnv ?? []) {
    delete probeEnv[name];
  }
  return { command: backend.command, env: probeEnv };
}
