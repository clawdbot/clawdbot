import type { ClawdbotConfig } from "../config/types.js";

export type ChatCommandDefinition = {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
};

export type NativeCommandSpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
};

const CHAT_COMMANDS: ChatCommandDefinition[] = [
  {
    key: "help",
    nativeName: "help",
    description: "Show available commands.",
    textAliases: ["/help"],
  },
  {
    key: "status",
    nativeName: "status",
    description: "Show current status.",
    textAliases: ["/status"],
  },
  {
    key: "stop",
    nativeName: "stop",
    description: "Stop the current run.",
    textAliases: ["/stop"],
  },
  {
    key: "restart",
    nativeName: "restart",
    description: "Restart Clawdbot.",
    textAliases: ["/restart"],
  },
  {
    key: "activation",
    nativeName: "activation",
    description: "Set group activation mode.",
    textAliases: ["/activation"],
    acceptsArgs: true,
  },
  {
    key: "send",
    nativeName: "send",
    description: "Set send policy.",
    textAliases: ["/send"],
    acceptsArgs: true,
  },
  {
    key: "reset",
    nativeName: "reset",
    description: "Reset the current session.",
    textAliases: ["/reset"],
  },
  {
    key: "new",
    nativeName: "new",
    description: "Start a new session.",
    textAliases: ["/new"],
  },
  {
    key: "think",
    nativeName: "think",
    description: "Set thinking level.",
    textAliases: ["/thinking", "/think", "/t"],
    acceptsArgs: true,
  },
  {
    key: "verbose",
    nativeName: "verbose",
    description: "Toggle verbose mode.",
    textAliases: ["/verbose", "/v"],
    acceptsArgs: true,
  },
  {
    key: "reasoning",
    nativeName: "reasoning",
    description: "Toggle reasoning visibility.",
    textAliases: ["/reasoning", "/reason"],
    acceptsArgs: true,
  },
  {
    key: "elevated",
    nativeName: "elevated",
    description: "Toggle elevated mode.",
    textAliases: ["/elevated", "/elev"],
    acceptsArgs: true,
  },
  {
    key: "model",
    nativeName: "model",
    description: "Show or set the model.",
    textAliases: ["/model"],
    acceptsArgs: true,
  },
  {
    key: "queue",
    nativeName: "queue",
    description: "Adjust queue settings.",
    textAliases: ["/queue"],
    acceptsArgs: true,
  },
];

const NATIVE_COMMAND_SURFACES = new Set(["discord", "slack", "telegram"]);

let cachedDetection:
  | {
      exact: Set<string>;
      regex: RegExp;
    }
  | undefined;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function listChatCommands(): ChatCommandDefinition[] {
  return [...CHAT_COMMANDS];
}

export function listNativeCommandSpecs(): NativeCommandSpec[] {
  return CHAT_COMMANDS.map((command) => ({
    name: command.nativeName,
    description: command.description,
    acceptsArgs: Boolean(command.acceptsArgs),
  }));
}

export function findCommandByNativeName(
  name: string,
): ChatCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return CHAT_COMMANDS.find(
    (command) => command.nativeName.toLowerCase() === normalized,
  );
}

export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

export function normalizeCommandBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return trimmed;
  const match = trimmed.match(/^\/([^\s:]+)\s*:(.*)$/);
  if (!match) return trimmed;
  const [, command, rest] = match;
  const normalizedRest = rest.trimStart();
  return normalizedRest ? `/${command} ${normalizedRest}` : `/${command}`;
}

export function getCommandDetection(): { exact: Set<string>; regex: RegExp } {
  if (cachedDetection) return cachedDetection;
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const command of CHAT_COMMANDS) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      exact.add(normalized);
      const escaped = escapeRegExp(normalized);
      if (!escaped) continue;
      if (command.acceptsArgs) {
        patterns.push(`${escaped}(?:\\s+.+|\\s*:\\s*.*)?`);
      } else {
        patterns.push(`${escaped}(?:\\s*:\\s*)?`);
      }
    }
  }
  const regex = patterns.length
    ? new RegExp(`^(?:${patterns.join("|")})$`, "i")
    : /$^/;
  cachedDetection = { exact, regex };
  return cachedDetection;
}

export function supportsNativeCommands(surface?: string): boolean {
  if (!surface) return false;
  return NATIVE_COMMAND_SURFACES.has(surface.toLowerCase());
}

export function shouldHandleTextCommands(params: {
  cfg: ClawdbotConfig;
  surface?: string;
  commandSource?: "text" | "native";
}): boolean {
  const { cfg, surface, commandSource } = params;
  const textEnabled = cfg.commands?.text !== false;
  if (commandSource === "native") return true;
  if (textEnabled) return true;
  return !supportsNativeCommands(surface);
}
