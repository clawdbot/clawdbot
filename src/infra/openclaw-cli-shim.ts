import fs from "node:fs/promises";
import path from "node:path";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeProfileName } from "../cli/profile-utils.js";
import { resolveStateDir } from "../config/paths.js";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { writeTextAtomic } from "./json-files.js";
import {
  resolveCurrentOpenClawCliInvocation,
  type OpenClawCliInvocation,
} from "./openclaw-cli-invocation.js";

const AGENT_CLI_BIN_DIR = path.join("tmp", "agent-cli");
const GATEWAY_AGENT_CLI_STATE_KEY = Symbol.for("openclaw.gatewayAgentCliShim");
const gatewayAgentCliState = resolveGlobalSingleton(
  GATEWAY_AGENT_CLI_STATE_KEY,
  () => ({ binDir: undefined as string | undefined }),
  (state) => {
    state.binDir = undefined;
  },
);

function quotePosixArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function renderPosixShim(invocation: OpenClawCliInvocation, profile: string | null): string {
  const args = [...invocation.args, ...(profile ? ["--profile", profile] : [])];
  return `#!/bin/sh
set -eu
exec ${[invocation.command, ...args].map(quotePosixArgument).join(" ")} "$@"
`;
}

function renderWindowsShim(invocation: OpenClawCliInvocation, profile: string | null): string {
  const args = [...invocation.args, ...(profile ? ["--profile", profile] : [])];
  return `@echo off\r\n${[invocation.command, ...args].map(quoteCmdScriptArg).join(" ")} %*\r\n`;
}

/**
 * Materialize the exact running Gateway CLI as an agent-visible PATH command.
 * The generated launcher is a runtime tool contract, not persisted product state.
 */
export async function prepareGatewayAgentCliShim(
  options: {
    env?: NodeJS.ProcessEnv;
    invocation?: OpenClawCliInvocation;
    platform?: NodeJS.Platform;
    stateDir?: string;
  } = {},
): Promise<{ binDir: string; executablePath: string }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const invocation = options.invocation ?? resolveCurrentOpenClawCliInvocation([]);
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  const binDir = path.join(options.stateDir ?? resolveStateDir(env), AGENT_CLI_BIN_DIR);
  const executablePath = path.join(binDir, platform === "win32" ? "openclaw.cmd" : "openclaw");
  const content =
    platform === "win32"
      ? renderWindowsShim(invocation, profile)
      : renderPosixShim(invocation, profile);

  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.chmod(binDir, 0o700).catch(() => undefined);
  await writeTextAtomic(executablePath, content, {
    mode: 0o700,
    dirMode: 0o700,
    durable: false,
    tempPrefix: "openclaw-agent-cli",
  });
  gatewayAgentCliState.binDir = binDir;
  return { binDir, executablePath };
}

/** Clear a prepared launcher after startup failure; normal Gateway close resets it globally. */
export function clearGatewayAgentCliShim(): void {
  gatewayAgentCliState.binDir = undefined;
}

/** Prepend the prepared Gateway CLI ahead of operator-configured exec PATH entries. */
export function mergeGatewayAgentCliPath(configured?: string[]): string[] | undefined {
  const merged = normalizeUniqueStringEntries([
    ...(gatewayAgentCliState.binDir ? [gatewayAgentCliState.binDir] : []),
    ...(configured ?? []),
  ]);
  return merged.length > 0 ? merged : undefined;
}
