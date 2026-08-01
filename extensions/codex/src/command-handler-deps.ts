import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import { installCodexComputerUse, readCodexComputerUseStatus } from "./app-server/computer-use.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import type { JsonValue } from "./app-server/protocol.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import type { CodexPluginsManagementIO } from "./command-plugins-management.js";
import {
  codexControlRequest,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  type CodexControlRequestOptions,
  type SafeValue,
} from "./command-rpc.js";
import { resolveCodexDefaultWorkspaceDir } from "./conversation-binding-data.js";
import {
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
} from "./conversation-control.js";
import {
  listCodexCliSessionsOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./node-cli-sessions.js";

type CodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<JsonValue | undefined>;

type SafeCodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<SafeValue<JsonValue | undefined>>;

type ListCodexCliSessionsOnNodeFn = (
  params: Omit<Parameters<typeof listCodexCliSessionsOnNode>[0], "runtime">,
) => ReturnType<typeof listCodexCliSessionsOnNode>;

type ResolveCodexCliSessionForBindingOnNodeFn = (
  params: Omit<Parameters<typeof resolveCodexCliSessionForBindingOnNode>[0], "runtime">,
) => ReturnType<typeof resolveCodexCliSessionForBindingOnNode>;

export type CodexCommandDeps = {
  bindingStore: CodexAppServerBindingStore;
  codexControlRequest: CodexControlRequestFn;
  listCodexAppServerModels: typeof listAllCodexAppServerModels;
  readCodexStatusProbes: typeof readCodexStatusProbes;
  requestOptions: typeof requestOptions;
  safeCodexControlRequest: SafeCodexControlRequestFn;
  readCodexComputerUseStatus: typeof readCodexComputerUseStatus;
  installCodexComputerUse: typeof installCodexComputerUse;
  resolveCodexDefaultWorkspaceDir: typeof resolveCodexDefaultWorkspaceDir;
  readCodexConversationActiveTurn: typeof readCodexConversationActiveTurn;
  setCodexConversationFastMode: typeof setCodexConversationFastMode;
  setCodexConversationModel: typeof setCodexConversationModel;
  setCodexConversationPermissions: typeof setCodexConversationPermissions;
  steerCodexConversationTurn: typeof steerCodexConversationTurn;
  stopCodexConversationTurn: typeof stopCodexConversationTurn;
  listCodexCliSessionsOnNode: ListCodexCliSessionsOnNodeFn;
  resolveCodexCliSessionForBindingOnNode: ResolveCodexCliSessionForBindingOnNodeFn;
  codexPluginsManagementIo?: CodexPluginsManagementIO;
};

export type CodexCommandDepsOverride = Pick<CodexCommandDeps, "bindingStore"> &
  Partial<Omit<CodexCommandDeps, "bindingStore">>;

const defaultCodexCommandDeps: Omit<CodexCommandDeps, "bindingStore"> = {
  codexControlRequest,
  listCodexAppServerModels: listAllCodexAppServerModels,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  readCodexComputerUseStatus,
  installCodexComputerUse,
  resolveCodexDefaultWorkspaceDir,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  listCodexCliSessionsOnNode: async () => {
    throw new Error("Codex CLI node sessions require Gateway node runtime.");
  },
  resolveCodexCliSessionForBindingOnNode: async () => {
    throw new Error("Codex CLI node sessions require Gateway node runtime.");
  },
};

export function resolveCodexCommandDeps(overrides: CodexCommandDepsOverride): CodexCommandDeps {
  return { ...defaultCodexCommandDeps, ...overrides };
}

export { CODEX_CONTROL_METHODS };
