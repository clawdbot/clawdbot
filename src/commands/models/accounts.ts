import { password } from "@clack/prompts";
import type {
  UsersAuthConnectResult,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusParams,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  UsersUnlinkAuthProfileResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { isTerminalInteractive } from "../../cli/terminal-interactivity.js";
import type { GatewayClient } from "../../gateway/client.js";
import { openUrl } from "../../infra/browser-open.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ExitError, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import {
  withModelsAccountsGateway,
  type ModelsAccountsGatewayOptions,
} from "./accounts-gateway.js";

export type ModelsAccountsOptions = ModelsAccountsGatewayOptions & { json?: boolean };

const SESSION_DEFAULT_NOTE =
  "This default applies to new sessions. Existing sessions keep their selected account.";

async function readAccountSecret(
  message: string,
  signal: AbortSignal,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  signal.throwIfAborted();
  const value = await password({
    message,
    mask: "",
    input: process.stdin,
    output: process.stderr,
    signal,
    clearOnError: true,
    validate: (input) => {
      const normalized = input?.trim() ?? "";
      if (!normalized || normalized.length > 8192) {
        return "Enter a value between 1 and 8192 characters.";
      }
      return validate?.(normalized);
    },
  });
  signal.throwIfAborted();
  if (typeof value === "symbol") {
    throw new ExitError(130, "Personal account sign-in cancelled.");
  }
  const secret = value.trim();
  registerSecretValueForRedaction(secret);
  return secret;
}

function isPending(result: UsersAuthConnectStatusResult): boolean {
  return result.status === "pending" || result.status === "exchanging";
}

async function waitForConnection(
  client: GatewayClient,
  params: UsersAuthConnectStatusParams,
  signal: AbortSignal,
): Promise<UsersAuthConnectStatusResult> {
  while (true) {
    const result = await client.request<UsersAuthConnectStatusResult>(
      "users.authConnect.status",
      params,
      { signal },
    );
    if (!isPending(result)) {
      return result;
    }
    await sleep(1_000, signal);
  }
}

async function connectOpenAI(
  client: GatewayClient,
  profileId: string,
  signal: AbortSignal,
  runtime: RuntimeEnv,
): Promise<UsersAuthConnectStatusResult> {
  signal.throwIfAborted();
  // Even after Ctrl-C, consume start's bounded response so cancellation can name
  // the exact operation; aborting only the request could leave its id unknown.
  const started = await client.request<UsersAuthConnectStartResult>("users.authConnect.start", {
    profileId,
    provider: "openai",
  });
  const params = { profileId, connectId: started.connectId };
  const completed = new AbortController();
  const waiting = AbortSignal.any([signal, completed.signal]);
  let poll: Promise<UsersAuthConnectStatusResult> | undefined;
  let manual: Promise<UsersAuthConnectStatusResult> | undefined;
  try {
    waiting.throwIfAborted();
    runtime.error(`Open this URL to sign in to ChatGPT:\n${sanitizeTerminalText(started.url)}`);
    await openUrl(started.url);
    waiting.throwIfAborted();
    runtime.error(
      "Waiting for browser sign-in. If it does not finish automatically, paste the final redirect URL below. Ctrl-C cancels sign-in.",
    );
    poll = waitForConnection(client, params, waiting);
    const result = poll;
    manual = readAccountSecret("Final redirect URL (hidden)", waiting).then(
      async (redirectInput) => {
        const response = await client.request<UsersAuthConnectStatusResult>(
          "users.authConnect.complete",
          { ...params, redirectInput },
          { signal: waiting },
        );
        return isPending(response) ? await result : response;
      },
    );
    return await Promise.race([poll, manual]);
  } catch (error) {
    completed.abort();
    let cancelled: UsersAuthConnectStatusResult;
    try {
      // Do not attach the aborted prompt signal: keep this socket until the
      // Gateway acknowledges cancellation or its bounded request fails.
      cancelled = await client.request<UsersAuthConnectStatusResult>(
        "users.authConnect.cancel",
        params,
        { timeoutMs: 3_000 },
      );
    } catch {
      throw new Error(
        "Could not confirm sign-in cancellation. The connection is closing; run `openclaw models accounts list` to check whether an account was saved.",
      );
    }
    if (cancelled.status === "connected" || error instanceof ExitError) {
      return cancelled;
    }
    throw new Error("Sign-in did not complete. Re-run `openclaw models accounts login openai`.", {
      cause: error,
    });
  } finally {
    completed.abort();
    await Promise.allSettled([poll, manual]);
  }
}

export async function modelsAccountsListCommand(
  options: ModelsAccountsOptions & { cursor?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  await withModelsAccountsGateway(options, "read", runtime, async ({ client, signal }) => {
    const result = await client.request<UsersListModelAccountsResult>(
      "users.listModelAccounts",
      options.cursor ? { cursor: options.cursor } : {},
      { signal },
    );
    if (options.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    runtime.log("Personal model accounts:");
    if (result.accounts.length === 0) {
      runtime.log(
        "No saved accounts on this page. Use `openclaw models accounts login <provider>`.",
      );
    }
    for (const account of result.accounts) {
      runtime.log(
        `${account.selected ? "*" : "-"} ${sanitizeTerminalText(account.authProfileId)}  ${sanitizeTerminalText(account.provider)}/${account.authType}  ${sanitizeTerminalText(account.label)}${account.selected ? " (new-session default)" : ""}`,
      );
    }
    runtime.log(SESSION_DEFAULT_NOTE);
    if (result.nextCursor) {
      runtime.log(
        `Next page: openclaw models accounts list --cursor ${sanitizeTerminalText(result.nextCursor)}`,
      );
    }
  });
}

export async function modelsAccountsLoginCommand(
  options: ModelsAccountsOptions & { provider: string },
  runtime: RuntimeEnv,
): Promise<void> {
  const provider = options.provider.trim().toLowerCase();
  if (provider !== "openai" && provider !== "anthropic") {
    throw new Error("Personal account login supports openai (ChatGPT) and anthropic (Claude).");
  }
  if (!isTerminalInteractive(process.stderr)) {
    throw new Error(
      "Personal account login requires an interactive terminal for hidden input. Run this command in a terminal, or use Profile in the Control UI. Never paste a token or redirect URL into chat or command arguments.",
    );
  }
  await withModelsAccountsGateway(
    options,
    "write",
    runtime,
    async ({ client, signal, profile }) => {
      const profileId = profile.id;
      let result: UsersAuthConnectStatusResult;
      if (provider === "openai") {
        result = await connectOpenAI(client, profileId, signal, runtime);
      } else {
        runtime.error(
          "Run `claude setup-token` in another terminal, then paste its token below. Do not send it in chat.",
        );
        const token = await readAccountSecret(
          "Claude setup-token (hidden)",
          signal,
          validateAnthropicSetupToken,
        );
        signal.throwIfAborted();
        const saved = await client.request<UsersAuthConnectResult>("users.authConnect.token", {
          profileId,
          provider,
          token,
        });
        result = { status: "connected", ...saved };
      }
      if (options.json) {
        writeRuntimeJson(runtime, { profileId, provider, ...result });
      }
      if (result.status === "connected") {
        if (!options.json) {
          runtime.log(
            `Signed in: ${sanitizeTerminalText(result.authProfileId)}. ${SESSION_DEFAULT_NOTE}`,
          );
        }
        return;
      }
      if (result.status === "cancelled") {
        runtime.error("Personal account sign-in cancelled.");
        throw new ExitError(130);
      }
      if (options.json) {
        throw new ExitError(1);
      }
      const reason = result.status === "failed" ? ` (${result.reason})` : "";
      throw new Error(
        `Personal account sign-in ${result.status}${reason}. Re-run the login command.`,
      );
    },
  );
}

export async function modelsAccountsUseCommand(
  options: ModelsAccountsOptions & { authProfileId: string },
  runtime: RuntimeEnv,
): Promise<void> {
  await withModelsAccountsGateway(
    options,
    "write",
    runtime,
    async ({ client, signal, profile }) => {
      const profileId = profile.id;
      const result = await client.request<UsersSelectModelAccountResult>(
        "users.selectModelAccount",
        { profileId, authProfileId: options.authProfileId },
        { signal },
      );
      if (options.json) {
        writeRuntimeJson(runtime, { profileId, ...result });
      } else {
        runtime.log(
          `Selected ${sanitizeTerminalText(options.authProfileId)}. ${SESSION_DEFAULT_NOTE}`,
        );
      }
    },
  );
}

export async function modelsAccountsClearDefaultCommand(
  options: ModelsAccountsOptions & { provider: string },
  runtime: RuntimeEnv,
): Promise<void> {
  await withModelsAccountsGateway(
    options,
    "write",
    runtime,
    async ({ client, signal, profile }) => {
      const profileId = profile.id;
      const result = await client.request<UsersUnlinkAuthProfileResult>(
        "users.unlinkAuthProfile",
        { profileId, provider: options.provider },
        { signal },
      );
      if (options.json) {
        writeRuntimeJson(runtime, { profileId, ...result });
      } else {
        runtime.log(
          `Cleared the ${sanitizeTerminalText(options.provider)} new-session default. Saved credentials and existing session accounts are unchanged.`,
        );
      }
    },
  );
}
