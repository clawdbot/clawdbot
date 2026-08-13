/** Command-source normalization for native slash commands, text slash commands, and plain messages. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type CommandTurnKind = "native" | "text-slash" | "normal";
/** Transport-level source labels carried through auto-reply dispatch. */
type CommandTurnSource = "native" | "text" | "message";

type BaseCommandTurnContext = {
  commandName?: string;
  body?: string;
};

type NativeCommandTurnContext = BaseCommandTurnContext & {
  kind: "native";
  source: "native";
  authorized: boolean;
};

type TextSlashCommandTurnContext = BaseCommandTurnContext & {
  kind: "text-slash";
  source: "text";
  authorized: boolean;
};

type NormalCommandTurnContext = BaseCommandTurnContext & {
  kind: "normal";
  source: "message";
  authorized: false;
};

export type CommandTurnContext =
  | NativeCommandTurnContext
  | TextSlashCommandTurnContext
  | NormalCommandTurnContext;

/** Loose inbound context shape accepted from channel adapters and tests before normalization. */
export type CommandTurnContextInput = {
  CommandTurn?: unknown;
  CommandSource?: unknown;
  CommandAuthorized?: unknown;
  CommandBody?: unknown;
  BodyForCommands?: unknown;
  RawBody?: unknown;
  Body?: unknown;
  commandText?: unknown;
  rawText?: unknown;
  BotUsername?: unknown;
};

function resolveCommandBody(input: CommandTurnContextInput): string | undefined {
  if (typeof input.commandText === "string") {
    return input.commandText;
  }
  return (
    normalizeOptionalString(input.CommandBody) ??
    normalizeOptionalString(input.BodyForCommands) ??
    normalizeOptionalString(input.RawBody) ??
    normalizeOptionalString(input.Body)
  );
}

function parseCommandName(body: string | undefined): string | undefined {
  if (!body?.startsWith("/")) {
    return undefined;
  }
  const name = body.slice(1).split(/\s+/, 1)[0]?.split("@", 1)[0];
  return normalizeOptionalString(name);
}

/** Maps the internal turn discriminator to the source value used by downstream routing. */
export function commandTurnKindToSource(kind: CommandTurnKind): CommandTurnSource {
  if (kind === "native") {
    return "native";
  }
  if (kind === "text-slash") {
    return "text";
  }
  return "message";
}

function normalizeCommandTurnKind(value: unknown): CommandTurnKind | undefined {
  return value === "native" || value === "text-slash" || value === "normal" ? value : undefined;
}

function normalizeCommandTurnSource(value: unknown): CommandTurnSource | undefined {
  return value === "native" || value === "text" || value === "message" ? value : undefined;
}

/** Maps source metadata back to the closed turn kind used by command checks. */
function commandTurnSourceToKind(source: CommandTurnSource): CommandTurnKind {
  if (source === "native") {
    return "native";
  }
  if (source === "text") {
    return "text-slash";
  }
  return "normal";
}

/** Builds a normalized command-turn context and forces normal messages to unauthorized. */
export function createCommandTurnContext(
  source: CommandTurnSource,
  input: {
    authorized: boolean;
    commandName?: string;
    body?: string;
  },
): CommandTurnContext {
  if (source === "native") {
    return {
      kind: "native",
      source: "native",
      authorized: input.authorized,
      commandName: input.commandName,
      body: input.body,
    };
  }
  if (source === "text") {
    return {
      kind: "text-slash",
      source: "text",
      authorized: input.authorized,
      commandName: input.commandName,
      body: input.body,
    };
  }
  return {
    kind: "normal",
    source: "message",
    authorized: false,
    commandName: input.commandName,
    body: input.body,
  };
}

function normalizeExplicitCommandTurn(
  value: unknown,
  input: CommandTurnContextInput,
): CommandTurnContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = normalizeCommandTurnKind(record.kind);
  const source =
    normalizeCommandTurnSource(record.source) ?? (kind ? commandTurnKindToSource(kind) : undefined);
  const resolvedKind = kind ?? (source ? commandTurnSourceToKind(source) : undefined);
  // Explicit metadata must describe one turn source; mixed kind/source pairs are ignored.
  if (kind && source && commandTurnKindToSource(kind) !== source) {
    return undefined;
  }
  if (!resolvedKind || !source) {
    return undefined;
  }
  const body = normalizeOptionalString(record.body) ?? resolveCommandBody(input);
  return createCommandTurnContext(source, {
    authorized:
      resolvedKind === "normal"
        ? false
        : typeof record.authorized === "boolean"
          ? record.authorized
          : input.CommandAuthorized === true,
    commandName: normalizeOptionalString(record.commandName) ?? parseCommandName(body),
    body,
  });
}

/** Normalizes command metadata with a legacy body fallback for older channel contexts. */
export function resolveCommandTurnContext(input: CommandTurnContextInput): CommandTurnContext {
  const explicit = normalizeExplicitCommandTurn(input.CommandTurn, input);
  if (explicit) {
    return explicit;
  }
  const source =
    input.CommandSource === "native"
      ? "native"
      : input.CommandSource === "text"
        ? "text"
        : "message";
  const body = resolveCommandBody(input);
  const kind = commandTurnSourceToKind(source);
  return createCommandTurnContext(source, {
    authorized: kind === "normal" ? false : input.CommandAuthorized === true,
    commandName: parseCommandName(body),
    body,
  });
}

/** Returns true for channel-native command turns. */
export function isNativeCommandTurn(commandTurn: CommandTurnContext | undefined): boolean {
  return commandTurn?.kind === "native";
}

/** Returns true for text slash-command turns regardless of authorization. */
export function isTextSlashCommandTurn(commandTurn: CommandTurnContext | undefined): boolean {
  return commandTurn?.kind === "text-slash";
}

export function isAuthorizedTextSlashCommandTurn(
  commandTurn: CommandTurnContext | undefined,
): boolean {
  return commandTurn?.kind === "text-slash" && commandTurn.authorized;
}

/** Returns true when a turn was explicitly invoked by a native or authorized text command. */
export function isExplicitCommandTurn(commandTurn: CommandTurnContext | undefined): boolean {
  return (
    commandTurn?.kind === "native" || (commandTurn?.kind === "text-slash" && commandTurn.authorized)
  );
}

/** Resolves the target session override allowed only for native command invocations. */
export function resolveCommandTurnTargetSessionKey(input: {
  CommandTurn?: CommandTurnContext;
  CommandSource?: unknown;
  CommandAuthorized?: unknown;
  CommandBody?: unknown;
  BodyForCommands?: unknown;
  RawBody?: unknown;
  Body?: unknown;
  commandText?: unknown;
  CommandTargetSessionKey?: unknown;
}): string | undefined {
  if (
    !isNativeCommandTurn(resolveCommandTurnContext(input)) ||
    typeof input.CommandTargetSessionKey !== "string"
  ) {
    return undefined;
  }
  const trimmed = input.CommandTargetSessionKey.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
