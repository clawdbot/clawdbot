import * as readline from "node:readline";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { classifyAcpToolApproval, type AcpApprovalClass } from "./approval-classifier.js";

type PermissionOption = RequestPermissionRequest["options"][number];

type PermissionResolverDeps = {
  prompt?: (toolName: string | undefined, toolTitle?: string) => Promise<boolean>;
  log?: (line: string) => void;
  cwd?: string;
};

function resolveToolKindForPermission(
  toolName: string | undefined,
  approvalClass: AcpApprovalClass,
): string | undefined {
  if (!toolName && approvalClass === "unknown") {
    return undefined;
  }
  if (approvalClass === "readonly_scoped") {
    return "readonly_scoped";
  }
  if (approvalClass === "readonly_search") {
    return "readonly_search";
  }
  return approvalClass;
}

function pickOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function selectedPermission(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function promptUserPermission(toolName: string | undefined, toolTitle?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const finish = (approved: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      resolve(approved);
    };

    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = normalizeLowercaseStringOrEmpty(answer) === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}

export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  deps: PermissionResolverDeps = {},
): Promise<RequestPermissionResponse> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const prompt = deps.prompt ?? promptUserPermission;
  const cwd = deps.cwd ?? process.cwd();
  const options = params.options ?? [];
  const toolTitle = sanitizeTerminalText(params.toolCall?.title ?? "tool");
  const classification = classifyAcpToolApproval({ toolCall: params.toolCall, cwd });
  const toolName = classification.toolName;
  const toolKind = resolveToolKindForPermission(toolName, classification.approvalClass);

  if (options.length === 0) {
    log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
    return cancelledPermission();
  }

  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
  const promptRequired = !classification.autoApprove;

  if (!promptRequired) {
    const option = allowOption ?? options[0];
    if (!option) {
      log(`[permission cancelled] ${toolName}: no selectable options`);
      return cancelledPermission();
    }
    log(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
    return selectedPermission(option.optionId);
  }

  log(
    `\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`,
  );
  const approved = await prompt(toolName, toolTitle);

  if (approved && allowOption) {
    return selectedPermission(allowOption.optionId);
  }
  if (!approved && rejectOption) {
    return selectedPermission(rejectOption.optionId);
  }

  log(
    `[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`,
  );
  return cancelledPermission();
}

type AcpClientSpawnEnvOptions = {
  stripKeys?: Iterable<string>;
};

export function resolveAcpClientSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: AcpClientSpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const env = omitEnvKeysCaseInsensitive(baseEnv, options.stripKeys ?? []);
  env.OPENCLAW_SHELL = "acp-client";
  return env;
}

export function shouldStripProviderAuthEnvVarsForAcpServer(
  params: {
    serverCommand?: string;
    serverArgs?: string[];
    defaultServerCommand?: string;
    defaultServerArgs?: string[];
  } = {},
): boolean {
  const serverCommand = normalizeOptionalString(params.serverCommand);
  if (!serverCommand) {
    return true;
  }
  const defaultServerCommand = normalizeOptionalString(params.defaultServerCommand);
  if (!defaultServerCommand || serverCommand !== defaultServerCommand) {
    return false;
  }
  const serverArgs = params.serverArgs ?? [];
  const defaultServerArgs = params.defaultServerArgs ?? [];
  return (
    serverArgs.length === defaultServerArgs.length &&
    serverArgs.every((arg, index) => arg === defaultServerArgs[index])
  );
}

export function buildAcpClientStripKeys(params: {
  stripProviderAuthEnvVars?: boolean;
  activeSkillEnvKeys?: Iterable<string>;
}): Set<string> {
  const stripKeys = new Set<string>(params.activeSkillEnvKeys ?? []);
  if (params.stripProviderAuthEnvVars) {
    for (const key of listKnownProviderAuthEnvVarNames()) {
      stripKeys.add(key);
    }
  }
  return stripKeys;
}

type AcpSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_ACP_SPAWN_RUNTIME: AcpSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveAcpClientSpawnInvocation(
  params: { serverCommand: string; serverArgs: string[] },
  runtime: AcpSpawnRuntime = DEFAULT_ACP_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: params.serverCommand,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "openclaw",
  });
  const resolved = materializeWindowsSpawnProgram(program, params.serverArgs);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}
