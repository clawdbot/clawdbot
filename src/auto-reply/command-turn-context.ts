export type CommandTurnKind = "native" | "text-slash" | "normal";
export type CommandTurnSource = "native" | "text" | "message";

type BaseCommandTurnContext = {
  commandName?: string;
  body?: string;
};

export type NativeCommandTurnContext = BaseCommandTurnContext & {
  kind: "native";
  source: "native";
  authorized: boolean;
};

export type TextSlashCommandTurnContext = BaseCommandTurnContext & {
  kind: "text-slash";
  source: "text";
  authorized: boolean;
};

export type NormalCommandTurnContext = BaseCommandTurnContext & {
  kind: "normal";
  source: "message";
  authorized: false;
};

export type CommandTurnContext =
  | NativeCommandTurnContext
  | TextSlashCommandTurnContext
  | NormalCommandTurnContext;

export type CommandTurnContextInput = {
  CommandTurn?: unknown;
  CommandSource?: unknown;
  CommandAuthorized?: unknown;
  CommandBody?: unknown;
  BodyForCommands?: unknown;
  RawBody?: unknown;
  Body?: unknown;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveCommandBody(input: CommandTurnContextInput): string | undefined {
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

function commandTurnKindToSource(kind: CommandTurnKind): CommandTurnSource {
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

function sourceToCommandTurnKind(source: CommandTurnSource): CommandTurnKind {
  if (source === "native") {
    return "native";
  }
  if (source === "text") {
    return "text-slash";
  }
  return "normal";
}

function buildCommandTurnContext(
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
  const resolvedKind = kind ?? (source ? sourceToCommandTurnKind(source) : undefined);
  if (kind && source && commandTurnKindToSource(kind) !== source) {
    return undefined;
  }
  if (!resolvedKind || !source) {
    return undefined;
  }
  const body = normalizeOptionalString(record.body) ?? resolveCommandBody(input);
  return buildCommandTurnContext(source, {
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
  const kind = sourceToCommandTurnKind(source);
  return buildCommandTurnContext(source, {
    authorized: kind === "normal" ? false : input.CommandAuthorized === true,
    commandName: parseCommandName(body),
    body,
  });
}

export function isExplicitCommandTurn(commandTurn: CommandTurnContext): boolean {
  return (
    commandTurn.kind === "native" || (commandTurn.kind === "text-slash" && commandTurn.authorized)
  );
}
