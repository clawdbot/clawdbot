import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  upsertAuthProfile,
} from "../agents/auth-profiles.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "./auth-token.js";
import { applyAuthProfileConfig, setAnthropicApiKey } from "./onboard-auth.js";

export async function applyAuthChoiceAnthropic(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "claude-cli") {
    let nextConfig = params.config;
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const hasClaudeCli = Boolean(store.profiles[CLAUDE_CLI_PROFILE_ID]);
    if (!hasClaudeCli && process.platform === "darwin") {
      await params.prompter.note(
        [
          "macOS will show a Keychain prompt next.",
          'Choose "Always Allow" so the launchd gateway can start without prompts.',
          'If you choose "Allow" or "Deny", each restart will block on a Keychain alert.',
        ].join("\n"),
        "Claude Code CLI Keychain",
      );
      const proceed = await params.prompter.confirm({
        message: "Check Keychain for Claude Code CLI credentials now?",
        initialValue: true,
      });
      if (!proceed) return { config: nextConfig };
    }

    const storeWithKeychain = hasClaudeCli
      ? store
      : ensureAuthProfileStore(params.agentDir, {
          allowKeychainPrompt: true,
        });

    if (!storeWithKeychain.profiles[CLAUDE_CLI_PROFILE_ID]) {
      if (process.stdin.isTTY) {
        const runNow = await params.prompter.confirm({
          message: "Run `claude setup-token` now?",
          initialValue: true,
        });
        if (runNow) {
          const res = await (async () => {
            const { spawnSync } = await import("node:child_process");
            return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
          })();
          if (res.error) {
            await params.prompter.note(
              `Failed to run claude: ${String(res.error)}`,
              "Claude setup-token",
            );
          }
        }
      } else {
        await params.prompter.note(
          "`claude setup-token` requires an interactive TTY.",
          "Claude setup-token",
        );
      }

      const refreshed = ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: true,
      });
      if (!refreshed.profiles[CLAUDE_CLI_PROFILE_ID]) {
        await params.prompter.note(
          process.platform === "darwin"
            ? 'No Claude Code CLI credentials found in Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json.'
            : "No Claude Code CLI credentials found at ~/.claude/.credentials.json.",
          "Claude Code CLI OAuth",
        );
        return { config: nextConfig };
      }
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "oauth",
    });
    return { config: nextConfig };
  }

  if (params.authChoice === "setup-token" || params.authChoice === "oauth") {
    let nextConfig = params.config;
    await params.prompter.note(
      [
        "This will run `claude setup-token` to create a long-lived Anthropic token.",
        "Requires an interactive TTY and a Claude Pro/Max subscription.",
      ].join("\n"),
      "Anthropic setup-token",
    );

    if (!process.stdin.isTTY) {
      await params.prompter.note(
        "`claude setup-token` requires an interactive TTY.",
        "Anthropic setup-token",
      );
      return { config: nextConfig };
    }

    const proceed = await params.prompter.confirm({
      message: "Run `claude setup-token` now?",
      initialValue: true,
    });
    if (!proceed) return { config: nextConfig };

    const res = await (async () => {
      const { spawnSync } = await import("node:child_process");
      return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    })();
    if (res.error) {
      await params.prompter.note(
        `Failed to run claude: ${String(res.error)}`,
        "Anthropic setup-token",
      );
      return { config: nextConfig };
    }
    if (typeof res.status === "number" && res.status !== 0) {
      await params.prompter.note(
        `claude setup-token failed (exit ${res.status})`,
        "Anthropic setup-token",
      );
      return { config: nextConfig };
    }

    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: true,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID]) {
      await params.prompter.note(
        `No Claude Code CLI credentials found after setup-token. Expected ${CLAUDE_CLI_PROFILE_ID}.`,
        "Anthropic setup-token",
      );
      return { config: nextConfig };
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "oauth",
    });
    return { config: nextConfig };
  }

  if (params.authChoice === "token") {
    let nextConfig = params.config;
    const provider = (await params.prompter.select({
      message: "Token provider",
      options: [{ value: "anthropic", label: "Anthropic (only supported)" }],
    })) as "anthropic";
    await params.prompter.note(
      ["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join(
        "\n",
      ),
      "Anthropic token",
    );

    const tokenRaw = await params.prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    const token = String(tokenRaw).trim();

    const profileNameRaw = await params.prompter.text({
      message: "Token name (blank = default)",
      placeholder: "default",
    });
    const namedProfileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    upsertAuthProfile({
      profileId: namedProfileId,
      agentDir: params.agentDir,
      credential: {
        type: "token",
        provider,
        token,
      },
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: namedProfileId,
      provider,
      mode: "token",
    });
    return { config: nextConfig };
  }

  if (params.authChoice === "apiKey") {
    let nextConfig = params.config;
    let hasCredential = false;
    const envKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing ANTHROPIC_API_KEY (env, ${formatApiKeyPreview(envKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setAnthropicApiKey(envKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Anthropic API key",
        validate: validateApiKeyInput,
      });
      await setAnthropicApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
    return { config: nextConfig };
  }

  return null;
}
