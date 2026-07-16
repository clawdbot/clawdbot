import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  listNativeCommandSpecsForConfig,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import type { createClickClackClient } from "./http-client.js";
import type { CoreConfig } from "./types.js";

const CLICKCLACK_COMMAND_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const CLICKCLACK_MAX_COMMANDS = 100;
const CLICKCLACK_MAX_DESCRIPTION_LENGTH = 100;
const CLICKCLACK_MAX_ARGS_HINT_LENGTH = 100;

type ClickClackCommandMenuEntry = {
  command: string;
  description: string;
  args_hint: string;
};

type ClickClackCommandMenuLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function commandArgsHint(spec: NativeCommandSpec): string {
  if (spec.args?.length) {
    return truncateCodePoints(
      spec.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" "),
      CLICKCLACK_MAX_ARGS_HINT_LENGTH,
    );
  }
  return spec.acceptsArgs ? "[args]" : "";
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function mapNativeCommandSpecsToClickClackMenu(
  specs: NativeCommandSpec[],
  log?: ClickClackCommandMenuLogger,
): ClickClackCommandMenuEntry[] {
  const commands: ClickClackCommandMenuEntry[] = [];
  const seen = new Set<string>();
  const invalidNames = new Set<string>();

  for (const spec of specs) {
    if (spec.isAlias) {
      continue;
    }
    const command = spec.name.trim().toLowerCase();
    if (!CLICKCLACK_COMMAND_PATTERN.test(command)) {
      invalidNames.add(spec.name.trim() || "<empty>");
      continue;
    }
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);

    const description = spec.description.trim() || command;
    commands.push({
      command,
      description: truncateCodePoints(description, CLICKCLACK_MAX_DESCRIPTION_LENGTH),
      args_hint: commandArgsHint(spec),
    });
  }

  if (invalidNames.size > 0) {
    log?.warn?.(
      `ClickClack command menu skipped invalid native command names: ${[...invalidNames]
        .map((name) => JSON.stringify(name))
        .join(", ")}`,
    );
  }

  return commands.slice(0, CLICKCLACK_MAX_COMMANDS);
}

export async function syncClickClackCommandMenu(params: {
  cfg: CoreConfig;
  client: ReturnType<typeof createClickClackClient>;
  log?: ClickClackCommandMenuLogger;
}): Promise<void> {
  try {
    // Native specs are the Phase 7c scope. Skill, plugin, and custom command
    // catalogs can be added later when their ClickClack semantics are defined.
    const specs = listNativeCommandSpecsForConfig(params.cfg, { provider: "clickclack" });
    const commands = mapNativeCommandSpecsToClickClackMenu(specs, params.log);
    await params.client.setBotCommands(commands);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 403) {
      params.log?.warn?.("ClickClack command menu sync skipped: bot token lacks commands:write");
      return;
    }
    if (status === 404) {
      params.log?.debug?.(
        "ClickClack command menu sync skipped: server does not support /api/bots/self/commands",
      );
      return;
    }
    params.log?.warn?.(`ClickClack command menu sync failed: ${formatErrorMessage(error)}`);
  }
}
