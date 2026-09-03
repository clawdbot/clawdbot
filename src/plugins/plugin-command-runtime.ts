/** Registry-bound plugin command selection and execution for native/channel surfaces. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactToolPayloadTextWithConfig } from "../logging/redact.js";
import type { RegisteredPluginCommand } from "./command-registry-state.js";
import { resolveManifestCommandAliasOwnerInRegistry } from "./manifest-command-aliases.js";
import { retainPluginCommandCatalogForCurrentAccount } from "./plugin-command-account-start-scope.js";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandReplyOptions,
} from "./plugin-command-dispatch-contract.js";
import { matchRegisteredPluginCommand, parsePluginInvocation } from "./plugin-command-matcher.js";
import {
  pluginCommandSupportsChannel,
  projectPluginCommandNativeMetadata,
} from "./plugin-command-metadata.js";
import {
  listRegisteredPluginCommands,
  resolveSelectedPluginCommandRegistry,
} from "./plugin-command-registry.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";

export { PLUGIN_COMMAND_DISPATCH };
export type { PluginCommandReplyOptions };

declare const pluginCommandDispatchBrand: unique symbol;

export type PluginCommandDispatchContext = Readonly<{
  senderId?: string;
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  senderIsOwner?: boolean;
  gatewayClientScopes?: PluginCommandContext["gatewayClientScopes"];
  agentId?: string;
  sessionKey?: PluginCommandContext["sessionKey"];
  sessionId?: PluginCommandContext["sessionId"];
  sessionTarget?: PluginCommandContext["sessionTarget"];
  sessionFile?: PluginCommandContext["sessionFile"];
  authProfileId?: string;
  commandBody: string;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  originatingTo?: string;
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
  threadParentId?: PluginCommandContext["threadParentId"];
  diagnosticsSessions?: PluginCommandContext["diagnosticsSessions"];
  diagnosticsUploadApproved?: PluginCommandContext["diagnosticsUploadApproved"];
  diagnosticsPreviewOnly?: PluginCommandContext["diagnosticsPreviewOnly"];
  diagnosticsPrivateRouted?: PluginCommandContext["diagnosticsPrivateRouted"];
  runtimeContext?: {
    compactCurrent?: (
      signal?: AbortSignal,
    ) => ReturnType<
      NonNullable<NonNullable<PluginCommandContext["runtimeContext"]>["compactCurrent"]>
    >;
  };
}>;

/** Opaque capability bound to one selected command in one registry generation. */
export type PluginCommandDispatch = Readonly<{
  kind: "plugin";
  execute: (context: PluginCommandDispatchContext) => Promise<PluginCommandResult>;
  [pluginCommandDispatchBrand]: true;
}>;

export type PluginCommandCatalogDecision = PluginCommandDispatch | Readonly<{ kind: "non-plugin" }>;

/** Internal reply-pipeline view after the opaque catalog decision has been validated. */
export type PluginCommandExecutionReplyOptions = Readonly<{
  [PLUGIN_COMMAND_DISPATCH]?: PluginCommandCatalogDecision;
}>;

export type PluginCommandNativeCandidate = Readonly<{
  name: string;
  description: string;
  descriptionLocalizations?: Readonly<Record<string, string>>;
  acceptsArgs: boolean;
  requireAuth: boolean;
  progressMessage?: string;
  prepareDispatch: (rawArgs?: string) => PluginCommandCatalogDecision;
}>;

type PluginCommandInvocationMatch = Readonly<{
  dispatch: PluginCommandDispatch;
  acceptsArgs: boolean;
  requireAuth: boolean;
  progressMessage?: string;
}>;

export type PluginCommandRuntime = Readonly<{
  listNativeCandidates: (provider: string) => readonly PluginCommandNativeCandidate[];
  retainNativeCatalog: (provider: string) => void;
}>;

type PluginCommandRuntimeState = Readonly<{
  registry: PluginRegistry;
  commands: readonly RegisteredPluginCommand[];
}>;

type SelectedCommand = {
  runtime: PluginCommandRuntime;
  registry: PluginRegistry;
  channel: string;
  selection:
    | { availability: "loaded"; command: RegisteredPluginCommand; args?: string }
    | { availability: "manifest-only"; plugin: PluginRecord };
};

const dispatchSelections = new WeakMap<object, SelectedCommand>();
const runtimeStates = new WeakMap<PluginCommandRuntime, PluginCommandRuntimeState>();

const INVALID_SELECTION_REPLY = {
  text: "⚠️ This command selection is no longer valid. Please try again.",
} as const;
const RETIRED_SELECTION_REPLY = {
  text: "⚠️ This command is no longer available after the plugin registry changed. Please try again.",
} as const;

function createSelectedPluginCommandDispatch(
  runtime: PluginCommandRuntime,
  state: PluginCommandRuntimeState,
  selection: SelectedCommand["selection"],
  channel: string,
): PluginCommandDispatch {
  const dispatch = Object.freeze({
    kind: "plugin" as const,
    async execute(this: PluginCommandDispatch, context: PluginCommandDispatchContext) {
      if (this !== dispatch) {
        return { ...INVALID_SELECTION_REPLY };
      }
      return await executeSelectedPluginCommand(runtime, dispatch, context);
    },
  }) as PluginCommandDispatch;
  dispatchSelections.set(dispatch as object, {
    runtime,
    registry: state.registry,
    selection,
    channel: normalizeOptionalLowercaseString(channel) ?? "",
  });
  return dispatch;
}

async function executeSelectedPluginCommand(
  runtime: PluginCommandRuntime | undefined,
  dispatch: PluginCommandDispatch,
  context: PluginCommandDispatchContext,
): Promise<PluginCommandResult> {
  const selected = dispatchSelections.get(dispatch as object);
  if (!selected || (runtime && selected.runtime !== runtime)) {
    return { ...INVALID_SELECTION_REPLY };
  }
  if (isPluginRegistryRetired(selected.registry)) {
    return { ...RETIRED_SELECTION_REPLY };
  }
  const channel = normalizeOptionalLowercaseString(context.channel) ?? "";
  if (selected.channel !== channel) {
    return { ...INVALID_SELECTION_REPLY };
  }
  const { selection } = selected;
  if (selection.availability === "manifest-only") {
    if (!context.isAuthorizedSender) {
      return { text: "⚠️ This command requires authorization." };
    }
    // Registration diagnostics may include stacks or secrets; chat gets a bounded summary.
    const reason = truncateUtf16Safe(
      redactToolPayloadTextWithConfig(
        selection.plugin.error?.split(/[\r\n]/, 1)[0]?.trim() || "reason not recorded",
        context.config.logging,
      ),
      240,
    );
    return {
      text: `⚠️ Plugin "${selection.plugin.id}" failed to load: ${reason}. Run \`openclaw doctor\` and check the gateway logs.`,
    };
  }
  const { executeRegisteredPluginCommand } = await import("./plugin-command-execution.js");
  if (isPluginRegistryRetired(selected.registry)) {
    return { ...RETIRED_SELECTION_REPLY };
  }
  return await executeRegisteredPluginCommand(selected.registry, {
    ...context,
    args: selection.args,
    command: selection.command,
  });
}

/** Validates and executes a dispatch carried through the core reply pipeline. */
export async function executePluginCommandDispatch(
  dispatch: PluginCommandDispatch,
  context: PluginCommandDispatchContext,
): Promise<PluginCommandResult> {
  return await executeSelectedPluginCommand(undefined, dispatch, context);
}

/** Creates one command runtime bound permanently to the current scoped registry generation. */
export function createPluginCommandRuntime(): PluginCommandRuntime {
  const registry = resolveSelectedPluginCommandRegistry();
  if (!registry) {
    throw new Error("Plugin command runtime requires an active or request-scoped registry.");
  }
  const state: PluginCommandRuntimeState = Object.freeze({
    registry,
    commands: Object.freeze(listRegisteredPluginCommands(registry)),
  });

  const assertCurrent = () => {
    if (isPluginRegistryRetired(state.registry)) {
      throw new Error("Plugin command runtime is bound to a retired registry generation.");
    }
  };

  const runtime: PluginCommandRuntime = Object.freeze({
    listNativeCandidates(provider: string): readonly PluginCommandNativeCandidate[] {
      assertCurrent();
      const channel = normalizeOptionalLowercaseString(provider) ?? "";
      return Object.freeze(
        state.commands
          .filter((command) => pluginCommandSupportsChannel(command, channel))
          .map((command) => {
            const metadata = projectPluginCommandNativeMetadata(command, channel);
            return Object.freeze({
              ...metadata,
              prepareDispatch(rawArgs?: string): PluginCommandCatalogDecision {
                const args = rawArgs?.trim();
                if (args && !command.acceptsArgs) {
                  return Object.freeze({ kind: "non-plugin" as const });
                }
                return createSelectedPluginCommandDispatch(
                  runtime,
                  state,
                  { availability: "loaded", command, args },
                  channel,
                );
              },
            });
          }),
      );
    },
    retainNativeCatalog(provider: string): void {
      assertCurrent();
      const channel = normalizeOptionalLowercaseString(provider) ?? "";
      if (!state.commands.some((command) => pluginCommandSupportsChannel(command, channel))) {
        return;
      }
      retainPluginCommandCatalogForCurrentAccount(channel);
    },
  });
  runtimeStates.set(runtime, state);
  return runtime;
}

/** Core-only text matcher that returns a dispatch from the same bound runtime. */
export function matchPluginCommandInvocation(
  runtime: PluginCommandRuntime,
  commandBody: string,
  options: { channel: string; provider?: string },
): PluginCommandInvocationMatch | null {
  const state = runtimeStates.get(runtime);
  if (!state) {
    return null;
  }
  if (isPluginRegistryRetired(state.registry)) {
    throw new Error("Plugin command runtime is bound to a retired registry generation.");
  }
  const channel = normalizeOptionalLowercaseString(options.channel) ?? "";
  const provider = normalizeOptionalLowercaseString(options.provider) ?? channel;
  const match = matchRegisteredPluginCommand({
    commands: state.commands,
    commandBody,
    channel,
    aliasScope: { kind: "provider", provider },
  });
  if (!match) {
    const owner = parsePluginInvocation(commandBody)
      ?.keys.map((key) =>
        resolveManifestCommandAliasOwnerInRegistry({
          command: key.slice(1),
          registry: state.registry,
        }),
      )
      .find((candidate) => candidate !== undefined);
    const plugin =
      owner?.kind === "runtime-slash"
        ? state.registry.plugins.find((entry) => entry.id === owner.pluginId)
        : undefined;
    if (plugin?.status !== "error" || !plugin.enabled) {
      return null;
    }
    return Object.freeze({
      dispatch: createSelectedPluginCommandDispatch(
        runtime,
        state,
        { availability: "manifest-only", plugin },
        channel,
      ),
      acceptsArgs: true,
      requireAuth: true,
    });
  }
  const metadata = projectPluginCommandNativeMetadata(match.command, provider);
  return Object.freeze({
    dispatch: createSelectedPluginCommandDispatch(
      runtime,
      state,
      { availability: "loaded", command: match.command, args: match.args },
      channel,
    ),
    acceptsArgs: metadata.acceptsArgs,
    requireAuth: metadata.requireAuth,
    ...(metadata.progressMessage ? { progressMessage: metadata.progressMessage } : {}),
  });
}
