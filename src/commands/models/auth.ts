import { spawnSync } from "node:child_process";

import { confirm as clackConfirm, select as clackSelect, text as clackText } from "@clack/prompts";

import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { CONFIG_PATH_CLAWDBOT } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { applyAuthProfileConfig } from "../onboard-auth.js";
import { updateConfig } from "./shared.js";

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

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
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

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
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
