import {
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  normalizeExecutableToken,
  unwrapDispatchWrappersForResolution,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  POWERSHELL_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";

type SystemRunCommandValidation =
  | {
      ok: true;
      shellPayload: string | null;
      commandText: string;
      previewText: string | null;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

type ResolvedSystemRunCommand =
  | {
      ok: true;
      argv: string[];
      commandText: string;
      shellPayload: string | null;
      previewText: string | null;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

export function formatExecCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg.length === 0) {
        return '""';
      }
      const needsQuotes = /\s|"/.test(arg);
      if (!needsQuotes) {
        return arg;
      }
      return `"${arg.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

export function extractShellCommandFromArgv(argv: string[]): string | null {
  return extractShellWrapperCommand(argv).command;
}

type SystemRunCommandDisplay = {
  shellPayload: string | null;
  commandText: string;
  previewText: string | null;
};

const POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES = new Set([
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

function unwrapShellWrapperArgv(argv: string[]): string[] {
  const dispatchUnwrapped = unwrapDispatchWrappersForResolution(argv);
  const shellMultiplexer = unwrapKnownShellMultiplexerInvocation(dispatchUnwrapped);
  return shellMultiplexer.kind === "unwrapped" ? shellMultiplexer.argv : dispatchUnwrapped;
}

function hasTrailingPositionalArgvAfterInlineCommand(argv: string[]): boolean {
  const wrapperArgv = unwrapShellWrapperArgv(argv);
  const token0 = wrapperArgv[0]?.trim();
  if (!token0) {
    return false;
  }

  const wrapper = normalizeExecutableToken(token0);
  if (!POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES.has(wrapper)) {
    return false;
  }

  const inlineCommandIndex =
    wrapper === "powershell" || wrapper === "pwsh"
      ? resolveInlineCommandMatch(wrapperArgv, POWERSHELL_INLINE_COMMAND_FLAGS).valueTokenIndex
      : resolveInlineCommandMatch(wrapperArgv, POSIX_INLINE_COMMAND_FLAGS, {
          allowCombinedC: true,
        }).valueTokenIndex;
  if (inlineCommandIndex === null) {
    return false;
  }
  return wrapperArgv.slice(inlineCommandIndex + 1).some((entry) => entry.trim().length > 0);
}

function buildSystemRunCommandDisplay(argv: string[]): SystemRunCommandDisplay {
  const shellWrapperResolution = extractShellWrapperCommand(argv);
  const shellPayload = shellWrapperResolution.command;
  const shellWrapperPositionalArgv = hasTrailingPositionalArgvAfterInlineCommand(argv);
  const envManipulationBeforeShellWrapper =
    shellWrapperResolution.isWrapper && hasEnvManipulationBeforeShellWrapper(argv);
  const formattedArgv = formatExecCommand(argv);
  const previewText =
    shellPayload !== null && !envManipulationBeforeShellWrapper && !shellWrapperPositionalArgv
      ? shellPayload.trim()
      : null;
  return {
    shellPayload,
    commandText: formattedArgv,
    previewText,
  };
}

function normalizeRawCommandText(rawCommand?: unknown): string | null {
  return typeof rawCommand === "string" && rawCommand.trim().length > 0 ? rawCommand.trim() : null;
}

export function validateSystemRunCommandConsistency(params: {
  argv: string[];
  rawCommand?: string | null;
  allowLegacyShellText?: boolean;
}): SystemRunCommandValidation {
  const raw = normalizeRawCommandText(params.rawCommand);
  const display = buildSystemRunCommandDisplay(params.argv);

  if (raw) {
    const matchesCanonicalArgv = raw === display.commandText;
    const matchesLegacyShellText =
      params.allowLegacyShellText === true &&
      display.previewText !== null &&
      raw === display.previewText;
    if (!matchesCanonicalArgv && !matchesLegacyShellText) {
      return {
        ok: false,
        message: "INVALID_REQUEST: rawCommand does not match command",
        details: {
          code: "RAW_COMMAND_MISMATCH",
          rawCommand: raw,
          inferred: display.commandText,
          formattedArgv: display.commandText,
        },
      };
    }
  }

  return {
    ok: true,
    shellPayload: display.shellPayload,
    commandText: display.commandText,
    previewText: display.previewText,
  };
}

export function resolveSystemRunCommand(params: {
  command?: unknown;
  rawCommand?: unknown;
}): ResolvedSystemRunCommand {
  return resolveSystemRunCommandWithMode(params, false);
}

export function resolveSystemRunCommandRequest(params: {
  command?: unknown;
  rawCommand?: unknown;
}): ResolvedSystemRunCommand {
  return resolveSystemRunCommandWithMode(params, true);
}

function resolveSystemRunCommandWithMode(
  params: {
    command?: unknown;
    rawCommand?: unknown;
  },
  allowLegacyShellText: boolean,
): ResolvedSystemRunCommand {
  const raw = normalizeRawCommandText(params.rawCommand);
  const command = Array.isArray(params.command) ? params.command : [];
  if (command.length === 0) {
    if (raw) {
      return {
        ok: false,
        message: "rawCommand requires params.command",
        details: { code: "MISSING_COMMAND" },
      };
    }
    return {
      ok: true,
      argv: [],
      commandText: "",
      shellPayload: null,
      previewText: null,
    };
  }

  const argv = command.map((v) => String(v));
  const validation = validateSystemRunCommandConsistency({
    argv,
    rawCommand: raw,
    allowLegacyShellText,
  });
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
      details: validation.details ?? { code: "RAW_COMMAND_MISMATCH" },
    };
  }

  return {
    ok: true,
    argv,
    commandText: validation.commandText,
    shellPayload: validation.shellPayload,
    previewText: validation.previewText,
  };
}
