import type { MsgContext } from "../auto-reply/templating.js";
import { applyTemplate } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LinkModelConfig, LinkToolsConfig } from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
// Link-understanding runner fetches allowed URLs and invokes configured commands with bounded content.
import { createAbortError, isAbortError } from "../infra/abort-signal.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { CLI_OUTPUT_MAX_BUFFER } from "../media-understanding/defaults.js";
import { resolveScopeDecision, resolveTimeoutMs } from "../media-understanding/resolve.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { DEFAULT_LINK_TIMEOUT_SECONDS } from "./defaults.js";
import { extractLinksFromMessage } from "./detect.js";

function resolveTimeoutMsFromConfig(params: {
  config?: LinkToolsConfig;
  entry: LinkModelConfig;
}): number {
  const configured = params.entry.timeoutSeconds ?? params.config?.timeoutSeconds;
  return resolveTimeoutMs(configured, DEFAULT_LINK_TIMEOUT_SECONDS);
}

function resolveFetchTimeoutMsFromConfig(params: {
  config?: LinkToolsConfig;
  entries: LinkModelConfig[];
}): number {
  // The HTTP fetch phase is independent of any single CLI execution, so honor
  // an explicit global link-tools timeout first. Otherwise use the largest
  // per-entry timeout so slower entries are not capped by the first entry.
  if (params.config?.timeoutSeconds != null) {
    return resolveTimeoutMs(params.config.timeoutSeconds, DEFAULT_LINK_TIMEOUT_SECONDS);
  }
  return Math.max(
    ...params.entries.map((entry) => resolveTimeoutMsFromConfig({ config: params.config, entry })),
  );
}

function isLinkUrlTemplate(value: string): boolean {
  return value.includes("LinkUrl") || value.includes("LinkFinalUrl");
}

function commandName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase();
}

function isUrlFetcherCommand(command: string): boolean {
  return commandName(command) === "curl" || commandName(command) === "wget";
}

function buildLinkCliArgs(params: {
  args: string[];
  ctx: MsgContext;
  finalUrl: string;
  url: string;
}): string[] {
  const templCtx = {
    ...params.ctx,
    LinkFinalUrl: params.finalUrl,
    LinkUrl: params.url,
  };
  return params.args
    .filter((arg) => !isLinkUrlTemplate(arg))
    .map((arg) => applyTemplate(arg, templCtx));
}

async function fetchLinkContent(params: {
  timeoutMs: number;
  url: string;
  signal?: AbortSignal;
}): Promise<{ content: string; finalUrl: string } | null> {
  const { response, finalUrl, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: params.timeoutMs,
    mode: GUARDED_FETCH_MODE.STRICT,
    auditContext: "link-understanding",
    signal: params.signal,
    init: {
      headers: {
        Accept: "text/*,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "OpenClaw-LinkUnderstanding/1.0",
      },
    },
  });
  try {
    if (!response.ok) {
      // Do not await: a debug-capture tee settles only after its sibling branch cancels.
      void cancelUnreadResponseBody(response);
      throw new Error(`Link fetch failed with HTTP ${response.status}`);
    }
    const buffer = await readResponseWithLimit(response, CLI_OUTPUT_MAX_BUFFER);
    const content = new TextDecoder().decode(buffer).trim();
    if (!content) {
      return null;
    }
    return { content, finalUrl };
  } finally {
    await release();
  }
}

async function runCliEntry(params: {
  content: string;
  entry: LinkModelConfig;
  finalUrl: string;
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  if ((params.entry.type ?? "cli") !== "cli") {
    return null;
  }
  const command = params.entry.command.trim();
  if (!command) {
    return null;
  }
  const args = params.entry.args ?? [];
  const timeoutMs = resolveTimeoutMsFromConfig({ config: params.config, entry: params.entry });
  if (isUrlFetcherCommand(command) && args.some(isLinkUrlTemplate)) {
    // curl/wget URL templates mark the entry as a fetcher; guarded fetch already supplied content.
    return params.content;
  }

  const argv = [
    command,
    ...buildLinkCliArgs({
      args,
      ctx: params.ctx,
      finalUrl: params.finalUrl,
      url: params.url,
    }),
  ];

  if (shouldLogVerbose()) {
    logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
  }

  const result = await runCommandWithTimeout(argv, {
    timeoutMs,
    input: params.content,
    signal: params.signal,
    // Processor wrappers and their children share the reply's cancellation lifetime.
    killProcessTree: true,
    env: {
      OPENCLAW_LINK_FINAL_URL: params.finalUrl,
      OPENCLAW_LINK_URL: params.url,
    },
  });
  if (params.signal?.aborted) {
    throw createAbortError("Link understanding command aborted", { cause: params.signal.reason });
  }
  if (result.code !== 0) {
    throw new Error(`Link understanding command exited with code ${result.code ?? "unknown"}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

async function runLinkEntries(params: {
  content: string;
  entries: LinkModelConfig[];
  finalUrl: string;
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  let lastError: unknown;
  for (const entry of params.entries) {
    if (params.signal?.aborted) {
      break;
    }
    try {
      const output = await runCliEntry({
        content: params.content,
        entry,
        finalUrl: params.finalUrl,
        ctx: params.ctx,
        url: params.url,
        config: params.config,
        signal: params.signal,
      });
      if (output) {
        return output;
      }
    } catch (err) {
      if (isAbortError(err)) {
        throw err;
      }
      lastError = err;
      if (shouldLogVerbose()) {
        logVerbose(`Link understanding failed for ${params.url}: ${String(err)}`);
      }
    }
  }
  if (lastError && shouldLogVerbose()) {
    logVerbose(`Link understanding exhausted for ${params.url}`);
  }
  return null;
}

/**
 * Fetches detected links through the SSRF guard and runs configured CLI processors.
 */
export async function runLinkUnderstanding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  message?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const config = params.cfg.tools?.links;
  if (!config || config.enabled === false) {
    return [];
  }

  const scopeDecision = resolveScopeDecision({ scope: config.scope, ctx: params.ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose("Link understanding disabled by scope policy.");
    }
    return [];
  }

  const message = params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const links = extractLinksFromMessage(message ?? "", { maxLinks: config?.maxLinks });
  if (links.length === 0) {
    return [];
  }

  const entries = config?.models ?? [];
  if (entries.length === 0) {
    return [];
  }

  const outputs: string[] = [];
  const timeoutMs = resolveFetchTimeoutMsFromConfig({ config, entries });
  for (const url of links) {
    if (params.signal?.aborted) {
      break;
    }
    let fetched: Awaited<ReturnType<typeof fetchLinkContent>>;
    try {
      fetched = await fetchLinkContent({ url, timeoutMs, signal: params.signal });
    } catch (err) {
      if (params.signal?.aborted) {
        throw createAbortError("Link understanding fetch aborted", { cause: params.signal.reason });
      }
      if (isAbortError(err)) {
        throw err;
      }
      if (shouldLogVerbose()) {
        logVerbose(`Link understanding fetch blocked or failed for ${url}: ${String(err)}`);
      }
      continue;
    }
    if (!fetched) {
      continue;
    }
    const output =
      (await runLinkEntries({
        content: fetched.content,
        entries,
        finalUrl: fetched.finalUrl,
        ctx: params.ctx,
        url,
        config,
        signal: params.signal,
      })) ?? fetched.content;
    if (params.signal?.aborted) {
      break;
    }
    if (output) {
      outputs.push(output);
    }
  }

  return outputs;
}
