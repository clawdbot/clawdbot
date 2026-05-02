import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { Client, overwriteApplicationCommands, type RequestClient } from "../internal/discord.js";
import {
  attachDiscordDeployRestContext,
  attachDiscordDeployRequestBody,
  formatDiscordDeployErrorDetails,
  formatDiscordDeployErrorMessage,
  formatDiscordDeployRateLimitDetails,
  formatDiscordDeployRateLimitWarning,
  isDiscordDeployDailyCreateLimit,
} from "./provider.deploy-errors.js";
import { logDiscordStartupPhase } from "./provider.startup-log.js";

type RestMethodName = "get" | "post" | "put" | "patch" | "delete";
type RestMethod = RequestClient[RestMethodName];
type RestMethodMap = Record<RestMethodName, RestMethod>;

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
  timeoutMs?: number;
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
      const requestMs = Date.now() - startedAt;
      attachDiscordDeployRequestBody(err, body);
      attachDiscordDeployRestContext(err, {
        method: params.method,
        path,
        requestMs,
        timeoutMs: params.timeoutMs,
      });
      const rateLimitDetails = formatDiscordDeployRateLimitDetails(err);
      if (rateLimitDetails) {
        if (params.shouldLogVerbose()) {
          params.runtime.log?.(
            warn(
              `discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:rate-limited ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${requestMs}${rateLimitDetails}`,
            ),
          );
        }
      } else {
        const details = formatDiscordDeployErrorDetails(err);
        params.runtime.error?.(
          `discord startup [${params.accountId}] native-slash-command-deploy-rest:${params.method}:error ${Math.max(0, Date.now() - params.startupStartedAt)}ms path=${path} requestMs=${requestMs} error=${formatDiscordDeployErrorMessage(err)}${details}`,
        );
      }
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
    const timeout = (params.rest as { options?: { timeout?: unknown } }).options?.timeout;
    params.rest[method] = wrapDeployRestMethod({
      method,
      original,
      runtime: params.runtime,
      accountId: params.accountId,
      startupStartedAt: params.startupStartedAt,
      timeoutMs: typeof timeout === "number" ? timeout : undefined,
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

async function deployDiscordCommands(params: {
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
  const restoreDeployRestLogging = installDeployRestLogging({
    rest: params.client.rest,
    runtime: params.runtime,
    accountId,
    startupStartedAt,
    shouldLogVerbose: params.shouldLogVerbose,
  });
  try {
    try {
      await params.client.deployCommands({ mode: "reconcile" });
      return;
    } catch (err) {
      if (isDiscordDeployDailyCreateLimit(err)) {
        params.runtime.log?.(
          warn(
            `discord: native slash command deploy skipped for ${accountId}; daily application command create limit reached. Existing slash commands stay active until Discord resets the quota. Message send/receive is unaffected.`,
          ),
        );
        return;
      }
      const rateLimitWarning = formatDiscordDeployRateLimitWarning(err, accountId);
      if (rateLimitWarning) {
        params.runtime.log?.(warn(rateLimitWarning));
        return;
      }
      throw err;
    }
  } catch (err) {
    params.runtime.log?.(
      warn(
        `discord: native slash command deploy warning (not message send): ${formatDiscordDeployErrorMessage(err)}${formatDiscordDeployErrorDetails(err)}`,
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
