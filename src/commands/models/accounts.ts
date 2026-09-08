import type {
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartParams,
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  UsersUnlinkAuthProfileResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { WizardStep } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { isTerminalInteractive } from "../../cli/terminal-interactivity.js";
import type { GatewayClient } from "../../gateway/client.js";
import { openUrl } from "../../infra/browser-open.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ExitError, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError, type WizardPrompter } from "../../wizard/prompts.js";
import {
  withModelsAccountsGateway,
  type ModelsAccountsGatewayOptions,
} from "./accounts-gateway.js";

export type ModelsAccountsOptions = ModelsAccountsGatewayOptions & { json?: boolean };

const SESSION_DEFAULT_NOTE =
  "This default applies to new sessions. Existing sessions keep their selected account.";

async function selectAccountChoice<T extends { id: string; label: string; hint?: string }>(
  message: string,
  choices: T[],
  requested: string | undefined,
  prompter: WizardPrompter,
): Promise<T> {
  if (choices.length === 0) {
    throw new Error(
      `No ${message.toLowerCase()} is available for personal accounts on this Gateway.`,
    );
  }
  const id =
    requested?.trim() ??
    (choices.length === 1
      ? choices[0]?.id
      : await prompter.select({
          message,
          options: choices.map((choice) => ({
            value: choice.id,
            label: sanitizeTerminalText(choice.label),
            hint: choice.hint && sanitizeTerminalText(choice.hint),
          })),
          searchable: true,
        }));
  const selected = choices.find((choice) => choice.id === id);
  if (!selected) {
    throw new Error(
      `Unknown ${message.toLowerCase()} ${sanitizeTerminalText(id ?? "")}. Available: ${choices.map((choice) => sanitizeTerminalText(choice.id)).join(", ")}.`,
    );
  }
  return selected;
}

async function answerAccountStep(
  step: WizardStep,
  signal: AbortSignal,
  runtime: RuntimeEnv,
): Promise<unknown> {
  const prompter = createClackPrompter(process.stderr, signal);
  signal.throwIfAborted();
  if (step.externalUrl) {
    runtime.error(`Open this URL to continue:\n${sanitizeTerminalText(step.externalUrl)}`);
    await openUrl(step.externalUrl);
    signal.throwIfAborted();
  }
  const message = sanitizeTerminalText(step.message ?? step.title ?? "Continue");
  const options =
    step.options?.map((option) => ({
      ...option,
      label: sanitizeTerminalText(option.label),
      hint: option.hint && sanitizeTerminalText(option.hint),
    })) ?? [];
  switch (step.type) {
    case "note":
      if (step.format === "plain") {
        await prompter.plain?.(message);
      } else {
        await prompter.note(message, step.title && sanitizeTerminalText(step.title));
      }
      return undefined;
    case "text": {
      const value = await prompter.text({
        message,
        sensitive: step.sensitive,
        placeholder: step.placeholder && sanitizeTerminalText(step.placeholder),
        initialValue:
          typeof step.initialValue === "string"
            ? sanitizeTerminalText(step.initialValue)
            : undefined,
      });
      if (step.sensitive) {
        registerSecretValueForRedaction(value);
      }
      return value;
    }
    case "select":
      return await prompter.select({
        message,
        options,
        initialValue: step.initialValue,
        searchable: true,
      });
    case "multiselect":
      return await prompter.multiselect({
        message,
        options,
        initialValues: Array.isArray(step.initialValue) ? step.initialValue : undefined,
        searchable: true,
      });
    case "confirm":
    case "action":
      return await prompter.confirm({
        message,
        initialValue: typeof step.initialValue === "boolean" ? step.initialValue : undefined,
      });
    case "progress":
      return undefined;
  }
  return undefined;
}

async function connectAccount(
  client: GatewayClient,
  start: UsersAuthConnectStartParams,
  signal: AbortSignal,
  runtime: RuntimeEnv,
): Promise<UsersAuthConnectStatusResult> {
  signal.throwIfAborted();
  // Consume start's bounded response even after Ctrl-C so cancellation can
  // retire the exact operation instead of leaving an unknown id on the Gateway.
  const started = await client.request<UsersAuthConnectStartResult>(
    "users.authConnect.start",
    start,
  );
  const params = { profileId: start.profileId, connectId: started.connectId };
  let active:
    | {
        id: string;
        controller: AbortController;
        answer: Promise<{ value: unknown } | { error: unknown }>;
      }
    | undefined;
  let displayedProgress: string | undefined;
  const retirePrompt = async () => {
    active?.controller.abort();
    await active?.answer;
    active = undefined;
  };
  try {
    signal.throwIfAborted();
    let result = await client.request<UsersAuthConnectStatusResult>(
      "users.authConnect.status",
      params,
      { signal },
    );
    while (result.status === "pending") {
      const step = result.step;
      if (active?.id !== step?.id) {
        await retirePrompt();
      }
      if (step?.type === "progress" || (step?.type === "action" && step.executor !== "client")) {
        if (displayedProgress !== step.id) {
          runtime.error(sanitizeTerminalText(step.message ?? step.title ?? "Working…"));
          displayedProgress = step.id;
        }
      } else if (step && !active) {
        const controller = new AbortController();
        active = {
          id: step.id,
          controller,
          answer: answerAccountStep(
            step,
            AbortSignal.any([signal, controller.signal]),
            runtime,
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
        };
      }
      // Status polling continues while input is open. RPCs remain serial so a
      // late poll cannot overwrite an answered step or terminal result.
      const tick = new AbortController();
      let answer: { value: unknown } | { error: unknown } | undefined;
      try {
        answer = await Promise.race([
          sleep(1_000, AbortSignal.any([signal, tick.signal])).then(() => undefined),
          ...(active ? [active.answer] : []),
        ]);
      } finally {
        tick.abort();
      }
      signal.throwIfAborted();
      if (answer && active) {
        const stepId = active.id;
        await retirePrompt();
        if ("error" in answer) {
          throw answer.error;
        }
        result = await client.request<UsersAuthConnectStatusResult>(
          "users.authConnect.answer",
          { ...params, stepId, value: answer.value },
          { signal },
        );
        if (result.status === "pending" && result.error) {
          runtime.error(sanitizeTerminalText(result.error));
        }
      } else {
        result = await client.request<UsersAuthConnectStatusResult>(
          "users.authConnect.status",
          params,
          { signal },
        );
      }
    }
    return result;
  } catch (error) {
    await retirePrompt();
    let cancelled: UsersAuthConnectStatusResult;
    try {
      // Keep the initiating socket until cancellation is acknowledged; the
      // cancelled prompt signal must not abort this bounded request.
      cancelled = await client.request<UsersAuthConnectStatusResult>(
        "users.authConnect.cancel",
        params,
        { timeoutMs: 3_000 },
      );
      if (cancelled.status === "pending") {
        throw new Error("The sign-in operation is still pending.", { cause: error });
      }
    } catch (cancelError) {
      throw new Error(
        "Could not confirm sign-in cancellation. The connection is closing; run `openclaw models accounts list` to check whether an account was saved.",
        { cause: cancelError },
      );
    }
    if (
      cancelled.status === "connected" ||
      error instanceof WizardCancelledError ||
      signal.aborted
    ) {
      return cancelled;
    }
    throw new Error("Sign-in did not complete. Re-run `openclaw models accounts login`.", {
      cause: error,
    });
  } finally {
    await retirePrompt();
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
      runtime.log("No saved accounts on this page. Use `openclaw models accounts login`.");
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
  options: ModelsAccountsOptions & { provider?: string; method?: string },
  runtime: RuntimeEnv,
): Promise<void> {
  if (!isTerminalInteractive(process.stderr)) {
    throw new Error(
      "Personal account login requires an interactive terminal for protected input. Run this command in a terminal, or use Connected accounts in Profile. Never paste credentials or authorization codes into chat or command arguments.",
    );
  }
  try {
    await withModelsAccountsGateway(
      options,
      "write",
      runtime,
      async ({ client, signal, profile }) => {
        const profileId = profile.id;
        const catalog = await client.request<UsersAuthConnectCatalogResult>(
          "users.authConnect.catalog",
          { profileId },
          { signal },
        );
        signal.throwIfAborted();
        const prompter = createClackPrompter(process.stderr, signal);
        const provider = await selectAccountChoice(
          "Provider",
          catalog.providers,
          options.provider,
          prompter,
        );
        const method = await selectAccountChoice(
          "Sign-in method",
          provider.methods,
          options.method,
          prompter,
        );
        signal.throwIfAborted();
        const result = await connectAccount(
          client,
          { profileId, provider: provider.id, method: method.id },
          signal,
          runtime,
        );
        if (options.json) {
          writeRuntimeJson(runtime, { profileId, provider: provider.id, ...result });
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
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      throw new ExitError(130, "Personal account sign-in cancelled.");
    }
    throw error;
  }
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
