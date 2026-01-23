import { spawnSync } from "node:child_process";

import { confirm as clackConfirm, select as clackSelect, text as clackText } from "@clack/prompts";

import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { readConfigFileSnapshot, type ClawdbotConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { applyAuthProfileConfig } from "../onboard-auth.js";
import { isRemoteEnvironment } from "../oauth-env.js";
import { openUrl } from "../onboard-helpers.js";
import { createVpsAwareOAuthHandlers } from "../oauth-flow.js";
import { updateConfig } from "./shared.js";
import { resolvePluginProviders } from "../../plugins/providers.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";

const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

type TokenProvider = "anthropic";

function resolveTokenProvider(raw?: string): TokenProvider | "custom" | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const normalized = normalizeProviderId(trimmed);
  if (normalized === "anthropic") return "anthropic";
  return "custom";
}

function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  const provider = resolveTokenProvider(opts.provider ?? "anthropic");
  if (provider !== "anthropic") {
    throw new Error(
      "Only --provider anthropic is supported for setup-token (uses `claude setup-token`).",
    );
  }

  if (!process.stdin.isTTY) {
    throw new Error("setup-token requires an interactive TTY.");
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: "Run `claude setup-token` now?",
      initialValue: true,
    });
    if (!proceed) return;
  }

  const res = spawnSync("claude", ["setup-token"], { stdio: "inherit" });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) {
    throw new Error(`claude setup-token failed (exit ${res.status})`);
  }

  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: true,
  });
  const synced = store.profiles[CLAUDE_CLI_PROFILE_ID];
  if (!synced) {
    throw new Error(
      `No Claude Code CLI credentials found after setup-token. Expected auth profile ${CLAUDE_CLI_PROFILE_ID}.`,
    );
  }

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "oauth",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${CLAUDE_CLI_PROFILE_ID} (anthropic/oauth)`);
}

export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
  },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);
  const profileId = opts.profileId?.trim() || resolveDefaultTokenProfileId(provider);

  const tokenInput = await text({
    message: `Paste token for ${provider}`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const token = String(tokenInput).trim();

  const expires =
    opts.expiresIn?.trim() && opts.expiresIn.trim().length > 0
      ? Date.now() + parseDurationMs(String(opts.expiresIn).trim(), { defaultUnit: "d" })
      : undefined;

  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
  });

  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }));

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
}

export async function modelsAuthAddCommand(_opts: Record<string, never>, runtime: RuntimeEnv) {
  const provider = (await select({
    message: "Token provider",
    options: [
      { value: "anthropic", label: "anthropic" },
      { value: "custom", label: "custom (type provider id)" },
    ],
  })) as TokenProvider | "custom";

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          String(
            await text({
              message: "Provider id",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ),
        )
      : provider;

  const method = (await select({
    message: "Token method",
    options: [
      ...(providerId === "anthropic"
        ? [
            {
              value: "setup-token",
              label: "setup-token (claude)",
              hint: "Runs `claude setup-token` (recommended)",
            },
          ]
        : []),
      { value: "paste", label: "paste token" },
    ],
  })) as "setup-token" | "paste";

  if (method === "setup-token") {
    await modelsAuthSetupTokenCommand({ provider: providerId }, runtime);
    return;
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = String(
    await text({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const wantsExpiry = await confirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? String(
        await text({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(String(value ?? ""), { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        }),
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand({ provider: providerId, profileId, expiresIn }, runtime);
}

type LoginOptions = {
  provider?: string;
  method?: string;
  setDefault?: boolean;
};

function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const raw = rawProvider?.trim();
  if (!raw) return null;
  const normalized = normalizeProviderId(raw);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null {
  const raw = rawMethod?.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  return (
    provider.auth.find((method) => method.id.toLowerCase() === normalized) ??
    provider.auth.find((method) => method.label.toLowerCase() === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function applyDefaultModel(cfg: ClawdbotConfig, model: string): ClawdbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") return "api_key";
  if (credential.type === "token") return "token";
  return "oauth";
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error("models auth login requires an interactive TTY.");
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }

  const config = snapshot.config;
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, defaultAgentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, defaultAgentId) ?? resolveDefaultAgentWorkspaceDir();

  const providers = resolvePluginProviders({ config, workspaceDir });
  if (providers.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("clawdbot plugins install")}\`.`,
    );
  }

  const prompter = createClackPrompter();
  const selectedProvider =
    resolveProviderMatch(providers, opts.provider) ??
    (await prompter
      .select({
        message: "Select a provider",
        options: providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(providers, String(id))));

  if (!selectedProvider) {
    throw new Error("Unknown provider. Use --provider <id> to pick a provider plugin.");
  }

  const chosenMethod =
    pickAuthMethod(selectedProvider, opts.method) ??
    (selectedProvider.auth.length === 1
      ? selectedProvider.auth[0]
      : await prompter
          .select({
            message: `Auth method for ${selectedProvider.label}`,
            options: selectedProvider.auth.map((method) => ({
              value: method.id,
              label: method.label,
              hint: method.hint,
            })),
          })
          .then((id) => selectedProvider.auth.find((method) => method.id === String(id))));

  if (!chosenMethod) {
    throw new Error("Unknown auth method. Use --method <id> to select one.");
  }

  const isRemote = isRemoteEnvironment();
  const result: ProviderAuthResult = await chosenMethod.run({
    config,
    agentDir,
    workspaceDir,
    prompter,
    runtime,
    isRemote,
    openUrl: async (url) => {
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (params) => createVpsAwareOAuthHandlers(params),
    },
  });

  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });
  }

  await updateConfig((cfg) => {
    let next = cfg;
    if (result.configPatch) {
      next = mergeConfigPatch(next, result.configPatch);
    }
    for (const profile of result.profiles) {
      next = applyAuthProfileConfig(next, {
        profileId: profile.profileId,
        provider: profile.credential.provider,
        mode: credentialMode(profile.credential),
      });
    }
    if (opts.setDefault && result.defaultModel) {
      next = applyDefaultModel(next, result.defaultModel);
    }
    return next;
  });

  logConfigUpdated(runtime);
  for (const profile of result.profiles) {
    runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (result.defaultModel) {
    runtime.log(
      opts.setDefault
        ? `Default model set to ${result.defaultModel}`
        : `Default model available: ${result.defaultModel} (use --set-default to apply)`,
    );
  }
  if (result.notes && result.notes.length > 0) {
    await prompter.note(result.notes.join("\n"), "Provider notes");
  }
}
