import type { Command } from "commander";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../plugins/install-request-context.js";

function isPluginInstallCommand(commandPath: string[]): boolean {
  return commandPath[0] === "plugins" && commandPath[1] === "install";
}

function resolvePluginInstallArgvTokens(commandPath: string[], argv: string[]): string[] {
  const args = argv.slice(2);
  let cursor = 0;
  for (const segment of commandPath) {
    while (cursor < args.length && args[cursor] !== segment) {
      cursor += 1;
    }
    if (cursor >= args.length) {
      return [];
    }
    cursor += 1;
  }
  return args.slice(cursor);
}

function resolvePluginInstallArgvRequest(commandPath: string[], argv: string[]) {
  if (!isPluginInstallCommand(commandPath)) {
    return null;
  }
  const tokens = resolvePluginInstallArgvTokens(commandPath, argv);
  let rawSpec: string | null = null;
  let marketplace: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens.at(index);
    if (token === undefined) {
      break;
    }
    if (token.startsWith("--marketplace=")) {
      marketplace = token.slice("--marketplace=".length);
      continue;
    }
    if (token === "--marketplace") {
      const value = tokens[index + 1];
      if (typeof value === "string") {
        marketplace = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    rawSpec ??= token;
  }
  return rawSpec ? { rawSpec, marketplace } : null;
}

/** Recover the plugin install request from Commander state plus raw argv fallback parsing. */
export function resolvePluginInstallPreactionRequest(params: {
  actionCommand: Command;
  commandPath: string[];
  argv: string[];
}): PluginInstallRequestContext | null {
  if (!isPluginInstallCommand(params.commandPath)) {
    return null;
  }
  const argvRequest = resolvePluginInstallArgvRequest(params.commandPath, params.argv);
  const opts = params.actionCommand.opts<Record<string, unknown>>();
  const marketplace =
    (typeof opts.marketplace === "string" && opts.marketplace.trim()
      ? opts.marketplace
      : argvRequest?.marketplace) || undefined;
  const rawSpec =
    (typeof params.actionCommand.processedArgs?.[0] === "string"
      ? params.actionCommand.processedArgs[0]
      : argvRequest?.rawSpec) ?? null;
  if (!rawSpec) {
    return null;
  }
  const request = resolvePluginInstallRequestContext({ rawSpec, marketplace });
  return request.ok ? request.request : null;
}
