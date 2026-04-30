import { inspect } from "node:util";
import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  Client,
  overwriteApplicationCommands,
  RateLimitError,
  type RequestClient,
} from "../internal/discord.js";
import { logDiscordStartupPhase } from "./provider.startup-log.js";

const DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT = 3;

type DiscordDeployErrorLike = {
  status?: unknown;
  discordCode?: unknown;
  rawBody?: unknown;
  deployRequestBody?: unknown;
};

type RestMethodName = "get" | "post" | "put" | "patch" | "delete";
type RestMethod = RequestClient[RestMethodName];
type RestMethodMap = Record<RestMethodName, RestMethod>;

function attachDiscordDeployRequestBody(err: unknown, body: unknown) {
  if (!err || typeof err !== "object" || body === undefined) {
    return;
  }
  const deployErr = err as DiscordDeployErrorLike;
  if (deployErr.deployRequestBody === undefined) {
    deployErr.deployRequestBody = body;
  }
}

function stringifyDiscordDeployField(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return inspect(value, { depth: 2, breakLength: 120 });
  }
}

function readDiscordDeployRejectedFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").slice(0, 6);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.keys(value).slice(0, 6);
}

function resolveDiscordRejectedDeployEntriesSource(
  rawBody: unknown,
): Record<string, unknown> | null {
  if (!rawBody || typeof rawBody !== "object") {
    return null;
  }
  const payload = rawBody as { errors?: unknown };
  const errors = payload.errors && typeof payload.errors === "object" ? payload.errors : undefined;
  const source = errors ?? rawBody;
  return source && typeof source === "object" ? (source as Record<string, unknown>) : null;
}

function formatDiscordRejectedDeployEntries(params: {
  rawBody: unknown;
  requestBody: unknown;
}): string[] {
  const requestBody = Array.isArray(params.requestBody) ? params.requestBody : null;
  const rejectedEntriesSource = resolveDiscordRejectedDeployEntriesSource(params.rawBody);
  if (!rejectedEntriesSource || !requestBody || requestBody.length === 0) {
    return [];
  }
  const rawEntries = Object.entries(rejectedEntriesSource).filter(([key]) => /^\d+$/.test(key));
  return rawEntries.slice(0, DISCORD_DEPLOY_REJECTED_ENTRY_LIMIT).flatMap(([key, value]) => {
    const index = Number.parseInt(key, 10);
    if (!Number.isFinite(index) || index < 0 || index >= requestBody.length) {
      return [];
    }
    const command = requestBody[index];
    if (!command || typeof command !== "object") {
      return [`#${index} fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`];
    }
    const payload = command as {
      name?: unknown;
      description?: unknown;
      options?: unknown;
    };
    const parts = [
      `#${index}`,
      `fields=${readDiscordDeployRejectedFields(value).join("|") || "unknown"}`,
    ];
    if (typeof payload.name === "string" && payload.name.trim().length > 0) {
      parts.push(`name=${payload.name}`);
    }
    if (payload.description !== undefined) {
      parts.push(`description=${stringifyDiscordDeployField(payload.description)}`);
    }
    if (Array.isArray(payload.options) && payload.options.length > 0) {
      parts.push(`options=${payload.options.length}`);
    }
    return [parts.join(" ")];
  });
}

export function formatDiscordDeployErrorDetails(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const status = (err as DiscordDeployErrorLike).status;
  const discordCode = (err as DiscordDeployErrorLike).discordCode;
  const rawBody = (err as DiscordDeployErrorLike).rawBody;
  const requestBody = (err as DiscordDeployErrorLike).deployRequestBody;
  const details: string[] = [];
  if (typeof status === "number") {
    details.push(`status=${status}`);
  }
  if (typeof discordCode === "number" || typeof discordCode === "string") {
    details.push(`code=${discordCode}`);
  }
  if (rawBody !== undefined) {
    let bodyText = "";
    try {
      bodyText = JSON.stringify(rawBody);
    } catch {
      bodyText =
        typeof rawBody === "string" ? rawBody : inspect(rawBody, { depth: 3, breakLength: 120 });
    }
    if (bodyText) {
      const maxLen = 800;
      const trimmed = bodyText.length > maxLen ? `${bodyText.slice(0, maxLen)}...` : bodyText;
      details.push(`body=${trimmed}`);
    }
  }
  const rejectedEntries = formatDiscordRejectedDeployEntries({ rawBody, requestBody });
  if (rejectedEntries.length > 0) {
    details.push(`rejected=${rejectedEntries.join("; ")}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function readDeployRequestBody(data?: unknown): unknown {
  return data && typeof data === "object" && "body" in data
    ? (data as { body?: unknown }).body
    : undefined;
}

function wrapDeployRestMethod(params: {
  method: RestMethodName;
  original: RestMethodMap;
  runtime: RuntimeEnv;
  accountId: string;
  startupStartedAt: number;
  shouldLogVerbose: () => boolean;
}) {
  return async (path: string, data?: never, query?: never) => {
    const startedAt = Date.now();
    const body = readDeployRequestBody(data);
    const commandCount = Array.isArray(body) ? body.length : undefined;
    const bodyBytes =
      body === undefined
        ? undefined
        : Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    if (params.shouldLogVerbose()) {
      params.runtime.log?.(
        `discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:start ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path}${typeof commandCount === "number" ? ` commands=${commandCount}` : ""}${typeof bodyBytes === "number" ? ` bytes=${bodyBytes}` : ""}`,
      );
    }
    try {
      const result = await params.original[params.method](path, data, query);
      if (params.shouldLogVerbose()) {
        params.runtime.log?.(
          `discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:done ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt}`,
        );
      }
      return result;
    } catch (err) {
      attachDiscordDeployRequestBody(err, body);
      const details = formatDiscordDeployErrorDetails(err);
      params.runtime.error?.(
        `discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:error ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${Date.now() - startedAt} error=${formatErrorMessage(err)}${details}`,
      );
      throw err;
    }
  };
}

function installDeployRestLogging(params: {
  rest: RequestClient;
  runtime: RuntimeEnv;
  accountId: string;
  startupStartedAt: number;
  shouldLogVerbose: () => boolean;
}): () => void {
  const original: RestMethodMap = {
    get: params.rest.get.bind(params.rest),
    post: params.rest.post.bind(params.rest),
    put: params.rest.put.bind(params.rest),
    patch: params.rest.patch.bind(params.rest),
    delete: params.rest.delete.bind(params.rest),
  };
  for (const method of Object.keys(original) as RestMethodName[]) {
    params.rest[method] = wrapDeployRestMethod({
      method,
      original,
      runtime: params.runtime,
      accountId: params.accountId,
      startupStartedAt: params.startupStartedAt,
      shouldLogVerbose: params.shouldLogVerbose,
    }) as RequestClient[typeof method];
  }
  return () => {
    params.rest.get = original.get;
    params.rest.post = original.post;
    params.rest.put = original.put;
    params.rest.patch = original.patch;
    params.rest.delete = original.delete;
  };
}

export async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId?: string;
  startupStartedAt?: number;
  shouldLogVerbose: () => boolean;
}) {
  if (!params.enabled) {
    return;
  }
  const startupStartedAt = params.startupStartedAt ?? Date.now();
  const accountId = params.accountId ?? "default";
  const maxAttempts = 3;
  const maxRetryDelayMs = 15_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const isDailyCreateLimit = (err: unknown) =>
    err instanceof RateLimitError &&
    err.discordCode === 30034 &&
    /daily application command creates/i.test(err.message);
  const restoreDeployRestLogging = installDeployRestLogging({
    rest: params.client.rest,
    runtime: params.runtime,
    accountId,
    startupStartedAt,
    shouldLogVerbose: params.shouldLogVerbose,
  });
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await params.client.deployCommands({ mode: "reconcile" });
        return;
      } catch (err) {
        if (isDailyCreateLimit(err)) {
          params.runtime.log?.(
            warn(
              `discord: native slash command deploy skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota. Message send/receive is unaffected.`,
            ),
          );
          return;
        }
        if (!(err instanceof RateLimitError) || attempt >= maxAttempts) {
          throw err;
        }
        const retryAfterMs = Math.max(0, Math.ceil(err.retryAfter * 1000));
        if (retryAfterMs > maxRetryDelayMs) {
          params.runtime.log?.(
            warn(
              `discord: native slash command deploy skipped for ${accountId}; retry_after=${retryAfterMs}ms exceeds startup budget. Existing slash commands stay active. Message send/receive is unaffected.`,
            ),
          );
          return;
        }
        if (params.shouldLogVerbose()) {
          params.runtime.log?.(
            `discord startup [${accountId}] deploy-retry ${Math.max(0, Date.now() - startupStartedAt)}ms attempt=${attempt}/${maxAttempts - 1} retryAfterMs=${retryAfterMs} scope=${err.scope ?? "unknown"} code=${err.discordCode ?? "unknown"}`,
          );
        }
        await sleep(retryAfterMs);
      }
    }
  } catch (err) {
    const details = formatDiscordDeployErrorDetails(err);
    params.runtime.log?.(
      warn(
        `discord: native slash command deploy warning (not message send): ${formatErrorMessage(err)}${details}`,
      ),
    );
  } finally {
    restoreDeployRestLogging();
  }
}

export function runDiscordCommandDeployInBackground(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId: string;
  startupStartedAt: number;
  shouldLogVerbose: () => boolean;
  isVerbose: () => boolean;
}) {
  if (!params.enabled) {
    return;
  }
  logDiscordStartupPhase({
    runtime: params.runtime,
    accountId: params.accountId,
    phase: "deploy-commands:scheduled",
    startAt: params.startupStartedAt,
    details: "mode=reconcile background=true",
    isVerbose: params.isVerbose,
  });
  void deployDiscordCommands(params)
    .then(() => {
      logDiscordStartupPhase({
        runtime: params.runtime,
        accountId: params.accountId,
        phase: "deploy-commands:done",
        startAt: params.startupStartedAt,
        details: "background=true",
        isVerbose: params.isVerbose,
      });
    })
    .catch((err: unknown) => {
      params.runtime.log?.(
        warn(
          `discord: native slash command deploy background warning (not message send): ${formatErrorMessage(err)}`,
        ),
      );
    });
}

export async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await overwriteApplicationCommands(params.client.rest, params.applicationId, []);
    params.runtime.log?.("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(`discord: failed to clear native commands: ${String(err)}`);
  }
}
