import { AsyncLocalStorage } from "node:async_hooks";
import { resolve as resolvePath } from "node:path";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
} from "acpx/runtime";
import { AcpRuntimeError, type AcpRuntime } from "../runtime-api.js";
import {
  createAcpxProcessLeaseId,
  hashAcpxProcessCommand,
  withAcpxLeaseEnvironment,
  type AcpxProcessLease,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawOwnedAcpxProcessCommand,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;
type BaseAcpxRuntimeTestOptions = ConstructorParameters<typeof BaseAcpxRuntime>[1];
type OpenClawAcpxRuntimeOptions = AcpRuntimeOptions & {
  openclawWrapperRoot?: string;
  openclawGatewayInstanceId?: string;
  openclawProcessLeaseStore?: AcpxProcessLeaseStore;
};
type AcpxRuntimeTestOptions = Record<string, unknown> & {
  openclawProcessCleanup?: AcpxProcessCleanupDeps;
};

type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

type AcpxLaunchLeaseContext = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  stableCommand?: string;
};

function readSessionRecordName(record: unknown): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

function readRecordAgentCommand(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { agentCommand } = record as { agentCommand?: unknown };
  return typeof agentCommand === "string" ? agentCommand.trim() || undefined : undefined;
}

function readRecordCwd(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { cwd } = record as { cwd?: unknown };
  return typeof cwd === "string" ? cwd.trim() || undefined : undefined;
}

function readRecordResetOnNextEnsure(record: unknown): boolean {
  if (typeof record !== "object" || record === null) {
    return false;
  }
  const { acpx } = record as { acpx?: unknown };
  if (typeof acpx !== "object" || acpx === null) {
    return false;
  }
  return (acpx as { reset_on_next_ensure?: unknown }).reset_on_next_ensure === true;
}

function readRecordAgentPid(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { pid, processId } = record as { pid?: unknown; processId?: unknown };
  const rawPid = pid ?? processId;
  const numericPid =
    typeof rawPid === "number"
      ? rawPid
      : typeof rawPid === "string"
        ? Number.parseInt(rawPid, 10)
        : undefined;
  return numericPid && Number.isInteger(numericPid) && numericPid > 0 ? numericPid : undefined;
}

function readOpenClawLeaseIdFromRecord(record: AcpLoadedSessionRecord): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { openclawLeaseId } = record as { openclawLeaseId?: unknown };
  return typeof openclawLeaseId === "string" ? openclawLeaseId.trim() || undefined : undefined;
}

function extractGeneratedWrapperPath(command: string | undefined): string {
  const parts = splitCommandParts(command ?? "");
  return (
    parts.find(
      (part) =>
        basename(part) === "codex-acp-wrapper.mjs" ||
        basename(part) === "claude-agent-acp-wrapper.mjs",
    ) ?? ""
  );
}

function selectCurrentSessionLease(params: {
  leases: AcpxProcessLease[];
  sessionKeys: string[];
  rootPid?: number;
}): AcpxProcessLease | undefined {
  const sessionKeys = new Set(params.sessionKeys.map((entry) => entry.trim()).filter(Boolean));
  const candidates = params.leases.filter((lease) => sessionKeys.has(lease.sessionKey));
  if (params.rootPid) {
    return candidates.find((lease) => lease.rootPid === params.rootPid);
  }
  let selected: AcpxProcessLease | undefined;
  for (const lease of candidates) {
    if (!selected || lease.startedAt > selected.startedAt) {
      selected = lease;
    }
  }
  return selected;
}

function createResetAwareSessionStore(
  baseStore: AcpSessionStore,
  params?: {
    gatewayInstanceId?: string;
    leaseStore?: AcpxProcessLeaseStore;
    launchScope?: AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>;
  },
): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const normalized = sessionId.trim();
      if (normalized && freshSessionKeys.has(normalized)) {
        return undefined;
      }
      const record = await baseStore.load(sessionId);
      if (!record || !params?.leaseStore || !params.gatewayInstanceId) {
        return record;
      }
      const sessionName = readSessionRecordName(record) || normalized;
      const lease = selectCurrentSessionLease({
        leases: await params.leaseStore.listOpen(params.gatewayInstanceId),
        sessionKeys: [sessionName, normalized],
        rootPid: readRecordAgentPid(record),
      });
      if (!lease) {
        return record;
      }
      return {
        ...(record as Record<string, unknown>),
        openclawLeaseId: lease.leaseId,
        openclawGatewayInstanceId: lease.gatewayInstanceId,
      } as AcpLoadedSessionRecord;
    },
    async save(record: AcpSessionRecord): Promise<void> {
      let recordToSave = record;
      const launch = params?.launchScope?.getStore();
      const sessionName = readSessionRecordName(record);
      const rootPid = readRecordAgentPid(record);
      const agentCommand = readRecordAgentCommand(record);
      const stableAgentCommand = launch?.stableCommand ?? agentCommand;
      if (
        launch &&
        params?.leaseStore &&
        sessionName === launch.sessionKey &&
        rootPid &&
        stableAgentCommand
      ) {
        const lease: AcpxProcessLease = {
          leaseId: launch.leaseId,
          gatewayInstanceId: launch.gatewayInstanceId,
          sessionKey: launch.sessionKey,
          wrapperRoot: launch.wrapperRoot,
          wrapperPath: extractGeneratedWrapperPath(stableAgentCommand),
          rootPid,
          commandHash: hashAcpxProcessCommand(stableAgentCommand),
          startedAt: Date.now(),
          state: "open",
        };
        await params.leaseStore.save(lease);
        recordToSave = {
          ...(record as Record<string, unknown>),
          // ACPX uses agentCommand as reuse identity. Lease metadata belongs to
          // our sidecar record, so keep the persisted command stable.
          agentCommand: stableAgentCommand,
          openclawLeaseId: launch.leaseId,
          openclawGatewayInstanceId: launch.gatewayInstanceId,
        } as AcpSessionRecord;
      }
      await baseStore.save(recordToSave);
      if (sessionName) {
        freshSessionKeys.delete(sessionName);
      }
    },
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}

const OPENCLAW_BRIDGE_EXECUTABLE = "openclaw";
const OPENCLAW_BRIDGE_SUBCOMMAND = "acp";
const CODEX_ACP_AGENT_ID = "codex";
const CODEX_ACP_OPENCLAW_PREFIX = "openai-codex/";
const CODEX_ACP_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CODEX_ACP_THINKING_ALIASES = new Map<string, string | undefined>([
  ["off", undefined],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["x-high", "xhigh"],
  ["x_high", "xhigh"],
  ["extra-high", "xhigh"],
  ["extra_high", "xhigh"],
  ["extra high", "xhigh"],
  ["xhigh", "xhigh"],
]);

type CodexAcpModelOverride = {
  model?: string;
  reasoningEffort?: string;
};

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function readAgentFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return undefined;
  }
  const match = /^agent:(?<agent>[^:]+):/i.exec(normalized);
  return normalizeAgentName(match?.groups?.agent);
}

function readAgentFromHandle(handle: AcpRuntimeHandle): string | undefined {
  const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
  if (typeof decoded === "object" && decoded !== null) {
    const { agent } = decoded as { agent?: unknown };
    if (typeof agent === "string") {
      return normalizeAgentName(agent) ?? readAgentFromSessionKey(handle.sessionKey);
    }
  }
  return readAgentFromSessionKey(handle.sessionKey);
}

function readAgentCommandFromRecord(record: AcpLoadedSessionRecord): string | undefined {
  return readRecordAgentCommand(record);
}

function readAgentPidFromRecord(record: AcpLoadedSessionRecord): number | undefined {
  return readRecordAgentPid(record);
}

function splitCommandParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function unwrapEnvCommand(parts: string[]): string[] {
  if (!parts.length || basename(parts[0]) !== "env") {
    return parts;
  }
  let index = 1;
  while (index < parts.length && isEnvAssignment(parts[index])) {
    index += 1;
  }
  return parts.slice(index);
}

function matchesExecutableName(value: string, executableName: string): boolean {
  const normalized = basename(value).toLowerCase();
  return normalized === executableName || normalized === `${executableName}.exe`;
}

function matchesPackageSpec(value: string, packageName: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === packageName || normalized.startsWith(`${packageName}@`);
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.[cm]?js$/i, "").toLowerCase();
}

function isAcpCommand(
  command: string | undefined,
  params: { packageName: string; executableName: string },
): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command.trim()));
  if (!parts.length) {
    return false;
  }
  if (parts.some((part) => matchesPackageSpec(part, params.packageName))) {
    return true;
  }
  const commandName = basename(parts[0] ?? "");
  if (matchesExecutableName(commandName, params.executableName)) {
    return true;
  }
  if (!matchesExecutableName(commandName, "node")) {
    return false;
  }
  const scriptName = stripModuleExtension(basename(parts[1] ?? ""));
  return scriptName === params.executableName || scriptName === `${params.executableName}-wrapper`;
}

function isOpenClawBridgeCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command.trim()));
  if (basename(parts[0] ?? "") === OPENCLAW_BRIDGE_EXECUTABLE) {
    return parts[1] === OPENCLAW_BRIDGE_SUBCOMMAND;
  }
  if (basename(parts[0] ?? "") !== "node") {
    return false;
  }
  const scriptName = basename(parts[1] ?? "");
  return /^openclaw(?:\.[cm]?js)?$/i.test(scriptName) && parts[2] === OPENCLAW_BRIDGE_SUBCOMMAND;
}

function isCodexAcpCommand(command: string | undefined): boolean {
  return isAcpCommand(command, {
    packageName: "@zed-industries/codex-acp",
    executableName: "codex-acp",
  });
}

function isClaudeAcpCommand(command: string | undefined): boolean {
  return isAcpCommand(command, {
    packageName: "@agentclientprotocol/claude-agent-acp",
    executableName: "claude-agent-acp",
  });
}

function failUnsupportedCodexAcpModel(rawModel: string, detail?: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    detail ??
      `Codex ACP model "${rawModel}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`,
  );
}

// acpx's `decodeAcpxRuntimeHandleState` only accepts `persistent` and `oneshot`; any other
// value silently round-trips through the encoded handle as `persistent` and later throws
// `SessionResumeRequiredError` on agent restart. Fail fast at this boundary instead.
// See openclaw/openclaw#73071.
const SUPPORTED_RUNTIME_SESSION_MODES = new Set(["persistent", "oneshot"] as const);
const WIRE_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);

function assertSupportedRuntimeSessionMode(
  mode: unknown,
): asserts mode is "persistent" | "oneshot" {
  if (typeof mode === "string" && SUPPORTED_RUNTIME_SESSION_MODES.has(mode as never)) {
    return;
  }
  const supported = Array.from(SUPPORTED_RUNTIME_SESSION_MODES).join(", ");
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Unsupported ACP runtime session mode ${JSON.stringify(mode)}. Expected one of: ${supported}.`,
  );
}

function failUnsupportedCodexAcpThinking(rawThinking: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP thinking level "${rawThinking}" is not supported. Use off, minimal, low, medium, high, or xhigh.`,
  );
}

function normalizeCodexAcpReasoningEffort(rawThinking: string | undefined): string | undefined {
  const normalized = rawThinking?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!CODEX_ACP_THINKING_ALIASES.has(normalized)) {
    failUnsupportedCodexAcpThinking(rawThinking ?? "");
  }
  return CODEX_ACP_THINKING_ALIASES.get(normalized);
}

function normalizeCodexAcpModelOverride(
  rawModel: string | undefined,
  rawThinking?: string,
): CodexAcpModelOverride | undefined {
  const raw = rawModel?.trim();
  const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);

  if (!raw) {
    return thinkingReasoningEffort ? { reasoningEffort: thinkingReasoningEffort } : undefined;
  }

  let value = raw;
  if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) {
    value = value.slice(CODEX_ACP_OPENCLAW_PREFIX.length);
  }
  const parts = value.split("/");
  if (parts.length > 2) {
    failUnsupportedCodexAcpModel(
      raw,
      `Codex ACP model "${raw}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`,
    );
  }
  const model = (parts[0] ?? "").trim();
  const modelReasoningEffort = normalizeCodexAcpReasoningEffort(parts[1]);
  if (!model) {
    failUnsupportedCodexAcpModel(
      raw,
      `Codex ACP model "${raw}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`,
    );
  }
  const reasoningEffort = thinkingReasoningEffort ?? modelReasoningEffort;
  if (reasoningEffort && !CODEX_ACP_REASONING_EFFORTS.has(reasoningEffort)) {
    failUnsupportedCodexAcpThinking(reasoningEffort);
  }
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function codexAcpSessionModelId(override: CodexAcpModelOverride): string {
  if (!override.model) {
    return "";
  }
  return override.reasoningEffort
    ? `${override.model}/${override.reasoningEffort}`
    : override.model;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendCodexAcpConfigOverrides(command: string, override: CodexAcpModelOverride): string {
  const configArgs = override.model ? [`model=${override.model}`] : [];
  if (override.reasoningEffort) {
    configArgs.push(`model_reasoning_effort=${override.reasoningEffort}`);
  }
  if (configArgs.length === 0) {
    return command;
  }
  return `${command} ${configArgs.map((arg) => `-c ${quoteShellArg(arg)}`).join(" ")}`;
}

function createModelScopedAgentRegistry(params: {
  agentRegistry: AcpAgentRegistry;
  scope: AsyncLocalStorage<CodexAcpModelOverride | undefined>;
  leaseCommand: (command: string | undefined) => string | undefined;
}): AcpAgentRegistry {
  return {
    resolve(agentName: string): string | undefined {
      const command = params.agentRegistry.resolve(agentName);
      const override = params.scope.getStore();
      if (
        !override ||
        normalizeAgentName(agentName) !== CODEX_ACP_AGENT_ID ||
        typeof command !== "string" ||
        !isCodexAcpCommand(command)
      ) {
        return params.leaseCommand(command);
      }
      return params.leaseCommand(appendCodexAcpConfigOverrides(command, override));
    },
    list(): string[] {
      return params.agentRegistry.list();
    },
  };
}

function resolveAgentCommand(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): string | undefined {
  const normalizedAgentName = normalizeAgentName(params.agentName);
  if (!normalizedAgentName) {
    return undefined;
  }
  const resolvedCommand = params.agentRegistry.resolve(normalizedAgentName);
  return typeof resolvedCommand === "string" ? resolvedCommand.trim() || undefined : undefined;
}

function resolveProbeAgentName(options: AcpRuntimeOptions): string {
  const { probeAgent } = options as { probeAgent?: unknown };
  return normalizeAgentName(typeof probeAgent === "string" ? probeAgent : undefined) ?? "codex";
}

function resolveAgentCommandForName(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): string | undefined {
  return resolveAgentCommand(params);
}

function shouldUseBridgeSafeDelegateForCommand(command: string | undefined): boolean {
  return isOpenClawBridgeCommand(command);
}

function shouldUseDistinctBridgeDelegate(options: AcpRuntimeOptions): boolean {
  const { mcpServers } = options as { mcpServers?: unknown };
  return Array.isArray(mcpServers) && mcpServers.length > 0;
}

export class AcpxRuntime implements AcpRuntime {
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly agentRegistry: AcpAgentRegistry;
  private readonly scopedAgentRegistry: AcpAgentRegistry;
  private readonly codexAcpModelOverrideScope = new AsyncLocalStorage<
    CodexAcpModelOverride | undefined
  >();
  private readonly delegate: BaseAcpxRuntime;
  private readonly bridgeSafeDelegate: BaseAcpxRuntime;
  private readonly probeDelegate: BaseAcpxRuntime;
  private readonly processCleanupDeps: AcpxProcessCleanupDeps | undefined;
  private readonly wrapperRoot: string | undefined;
  private readonly gatewayInstanceId: string | undefined;
  private readonly processLeaseStore: AcpxProcessLeaseStore | undefined;
  private readonly launchLeaseScope = new AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>();
  private readonly cwd: string;

  constructor(options: OpenClawAcpxRuntimeOptions, testOptions?: AcpxRuntimeTestOptions) {
    const { openclawProcessCleanup, ...delegateTestOptions } = testOptions ?? {};
    this.processCleanupDeps = openclawProcessCleanup;
    this.wrapperRoot = options.openclawWrapperRoot;
    this.gatewayInstanceId = options.openclawGatewayInstanceId;
    this.processLeaseStore = options.openclawProcessLeaseStore;
    this.cwd = options.cwd;
    this.sessionStore = createResetAwareSessionStore(options.sessionStore, {
      gatewayInstanceId: this.gatewayInstanceId,
      leaseStore: this.processLeaseStore,
      launchScope: this.launchLeaseScope,
    });
    this.agentRegistry = options.agentRegistry;
    this.scopedAgentRegistry = createModelScopedAgentRegistry({
      agentRegistry: this.agentRegistry,
      scope: this.codexAcpModelOverrideScope,
      leaseCommand: (command) => this.commandWithLaunchLease(command),
    });
    const sharedOptions = {
      ...options,
      sessionStore: this.sessionStore,
      agentRegistry: this.scopedAgentRegistry,
    };
    this.delegate = new BaseAcpxRuntime(
      sharedOptions,
      delegateTestOptions as BaseAcpxRuntimeTestOptions,
    );
    this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options)
      ? new BaseAcpxRuntime(
          {
            ...sharedOptions,
            mcpServers: [],
          },
          delegateTestOptions as BaseAcpxRuntimeTestOptions,
        )
      : this.delegate;
    this.probeDelegate = this.resolveDelegateForAgent(resolveProbeAgentName(options));
  }

  private resolveDelegateForAgent(agentName: string | undefined): BaseAcpxRuntime {
    const command = resolveAgentCommandForName({
      agentName,
      agentRegistry: this.agentRegistry,
    });
    return this.resolveDelegateForCommand(command);
  }

  private resolveDelegateForCommand(command: string | undefined): BaseAcpxRuntime {
    return shouldUseBridgeSafeDelegateForCommand(command) ? this.bridgeSafeDelegate : this.delegate;
  }

  private async resolveDelegateForHandle(handle: AcpRuntimeHandle): Promise<BaseAcpxRuntime> {
    const record = await this.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
    return this.resolveDelegateForLoadedRecord(handle, record);
  }

  private resolveDelegateForLoadedRecord(
    handle: AcpRuntimeHandle,
    record: AcpLoadedSessionRecord,
  ): BaseAcpxRuntime {
    const recordCommand = readAgentCommandFromRecord(record);
    if (recordCommand) {
      return this.resolveDelegateForCommand(recordCommand);
    }
    return this.resolveDelegateForAgent(readAgentFromHandle(handle));
  }

  private async resolveCommandForHandle(handle: AcpRuntimeHandle): Promise<string | undefined> {
    const record = await this.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
    const recordCommand = readAgentCommandFromRecord(record);
    if (recordCommand) {
      return recordCommand;
    }
    return resolveAgentCommandForName({
      agentName: readAgentFromHandle(handle),
      agentRegistry: this.agentRegistry,
    });
  }

  private commandWithLaunchLease(command: string | undefined): string | undefined {
    const launch = this.launchLeaseScope.getStore();
    if (!command || !launch) {
      return command;
    }
    launch.stableCommand = command;
    return withAcpxLeaseEnvironment({
      command,
      leaseId: launch.leaseId,
      gatewayInstanceId: launch.gatewayInstanceId,
    });
  }

  private async canReuseStablePersistentSession(params: {
    sessionKey: string;
    mode: Parameters<AcpRuntime["ensureSession"]>[0]["mode"];
    cwd: string | undefined;
    command: string | undefined;
    resumeSessionId: string | undefined;
  }): Promise<boolean> {
    if (params.mode !== "persistent" || !params.command) {
      return false;
    }
    const existing = await this.sessionStore.load(params.sessionKey);
    if (!existing || readRecordResetOnNextEnsure(existing)) {
      return false;
    }
    const recordCwd = readRecordCwd(existing);
    if (!recordCwd || resolvePath(recordCwd) !== resolvePath(params.cwd?.trim() || this.cwd)) {
      return false;
    }
    if (readRecordAgentCommand(existing) !== params.command) {
      return false;
    }
    const existingSessionId =
      typeof existing === "object" && existing !== null
        ? (existing as { acpSessionId?: unknown }).acpSessionId
        : undefined;
    return !params.resumeSessionId || existingSessionId === params.resumeSessionId;
  }

  private async runWithLaunchLease<T>(params: {
    sessionKey: string;
    command: string | undefined;
    enabled?: boolean;
    run: () => Promise<T>;
  }): Promise<T> {
    if (
      params.enabled === false ||
      !params.command ||
      !this.wrapperRoot ||
      !this.gatewayInstanceId ||
      !this.processLeaseStore ||
      !isOpenClawOwnedAcpxProcessCommand({
        command: params.command,
        wrapperRoot: this.wrapperRoot,
      })
    ) {
      return await params.run();
    }
    const launch: AcpxLaunchLeaseContext = {
      leaseId: createAcpxProcessLeaseId(),
      gatewayInstanceId: this.gatewayInstanceId,
      sessionKey: params.sessionKey,
      wrapperRoot: this.wrapperRoot,
      stableCommand: params.command,
    };
    // The pending lease is written before acpx spawns. The session-store save
    // path fills in the live PID after acpx connects and exposes the process.
    await this.processLeaseStore.save({
      leaseId: launch.leaseId,
      gatewayInstanceId: launch.gatewayInstanceId,
      sessionKey: launch.sessionKey,
      wrapperRoot: launch.wrapperRoot,
      wrapperPath: extractGeneratedWrapperPath(params.command),
      rootPid: 0,
      commandHash: hashAcpxProcessCommand(params.command),
      startedAt: Date.now(),
      state: "open",
    });
    return await this.launchLeaseScope.run(launch, params.run);
  }

  private async cleanupProcessTreeForRecord(
    handle: AcpRuntimeHandle,
    record: AcpLoadedSessionRecord,
  ): Promise<void> {
    const leaseId = readOpenClawLeaseIdFromRecord(record);
    const rootPid = readAgentPidFromRecord(record);
    const sessionKeys = [handle.sessionKey, readSessionRecordName(record)];
    const openLeases =
      this.gatewayInstanceId && this.processLeaseStore
        ? await this.processLeaseStore.listOpen(this.gatewayInstanceId)
        : [];
    const selectedLease = selectCurrentSessionLease({
      leases: openLeases,
      sessionKeys,
      rootPid,
    });
    const loadedLease = leaseId ? await this.processLeaseStore?.load(leaseId) : undefined;
    const lease =
      selectedLease ??
      (loadedLease &&
      loadedLease.gatewayInstanceId === this.gatewayInstanceId &&
      (!rootPid || loadedLease.rootPid === rootPid) &&
      sessionKeys.includes(loadedLease.sessionKey)
        ? loadedLease
        : undefined);
    if (lease && lease.gatewayInstanceId === this.gatewayInstanceId && lease.rootPid > 0) {
      await this.processLeaseStore?.markState(lease.leaseId, "closing");
      const result = await cleanupOpenClawOwnedAcpxProcessTree({
        rootPid: lease.rootPid,
        rootCommand: readAgentCommandFromRecord(record),
        expectedLeaseId: lease.leaseId,
        expectedGatewayInstanceId: lease.gatewayInstanceId,
        wrapperRoot: lease.wrapperRoot,
        deps: this.processCleanupDeps,
      });
      await this.processLeaseStore?.markState(
        lease.leaseId,
        result.terminatedPids.length > 0 || result.skippedReason === "missing-root"
          ? "closed"
          : "lost",
      );
      return;
    }

    const rootCommand =
      readAgentCommandFromRecord(record) ??
      resolveAgentCommandForName({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    if (!rootPid || !rootCommand) {
      return;
    }
    await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid,
      rootCommand,
      wrapperRoot: this.wrapperRoot,
      deps: this.processCleanupDeps,
    });
  }

  isHealthy(): boolean {
    return this.probeDelegate.isHealthy();
  }

  probeAvailability(): Promise<void> {
    return this.probeDelegate.probeAvailability();
  }

  doctor(): Promise<AcpRuntimeDoctorReport> {
    return this.probeDelegate.doctor();
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<AcpRuntimeHandle> {
    assertSupportedRuntimeSessionMode(input.mode);
    const command = resolveAgentCommandForName({
      agentName: input.agent,
      agentRegistry: this.agentRegistry,
    });
    const delegate = this.resolveDelegateForCommand(command);
    const codexModelOverride =
      normalizeAgentName(input.agent) === CODEX_ACP_AGENT_ID && isCodexAcpCommand(command)
        ? normalizeCodexAcpModelOverride(input.model, input.thinking)
        : undefined;
    const stableLaunchCommand =
      codexModelOverride && command
        ? appendCodexAcpConfigOverrides(command, codexModelOverride)
        : command;
    const shouldStartWithLease = !(await this.canReuseStablePersistentSession({
      sessionKey: input.sessionKey,
      mode: input.mode,
      cwd: input.cwd,
      command: stableLaunchCommand,
      resumeSessionId: input.resumeSessionId,
    }));

    if (!codexModelOverride) {
      return await this.runWithLaunchLease({
        sessionKey: input.sessionKey,
        command: stableLaunchCommand,
        enabled: shouldStartWithLease,
        run: () => delegate.ensureSession(input),
      });
    }

    const normalizedInput = {
      ...input,
      ...(codexAcpSessionModelId(codexModelOverride)
        ? { model: codexAcpSessionModelId(codexModelOverride) }
        : {}),
    };
    return await this.runWithLaunchLease({
      sessionKey: input.sessionKey,
      command: stableLaunchCommand,
      enabled: shouldStartWithLease,
      run: () =>
        this.codexAcpModelOverrideScope.run(codexModelOverride, () =>
          delegate.ensureSession(normalizedInput),
        ),
    });
  }

  async *runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    yield* (await this.resolveDelegateForHandle(input.handle)).runTurn(input);
  }

  getCapabilities(): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities();
  }

  async getStatus(
    input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0],
  ): Promise<AcpRuntimeStatus> {
    const delegate = await this.resolveDelegateForHandle(input.handle);
    return delegate.getStatus(input);
  }

  async setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    const delegate = await this.resolveDelegateForHandle(input.handle);
    await delegate.setMode(input);
  }

  async setConfigOption(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
  ): Promise<void> {
    const delegate = await this.resolveDelegateForHandle(input.handle);
    const command = await this.resolveCommandForHandle(input.handle);
    const key = input.key.trim().toLowerCase();
    const isCodexAcp = isCodexAcpCommand(command);
    if (WIRE_TIMEOUT_CONFIG_KEYS.has(key) && (isCodexAcp || isClaudeAcpCommand(command))) {
      return;
    }
    if (isCodexAcp) {
      if (
        key === "model" ||
        key === "thinking" ||
        key === "thought_level" ||
        key === "reasoning_effort"
      ) {
        const override =
          key === "model"
            ? normalizeCodexAcpModelOverride(input.value)
            : normalizeCodexAcpModelOverride(undefined, input.value);
        if (!override && key !== "model") {
          return;
        }
        if (override) {
          if (override.model) {
            await delegate.setConfigOption({
              ...input,
              key: "model",
              value: override.model,
            });
          }
          if (override.reasoningEffort) {
            await delegate.setConfigOption({
              ...input,
              key: "reasoning_effort",
              value: override.reasoningEffort,
            });
          }
          return;
        }
      }
    }
    await delegate.setConfigOption(input);
  }

  async cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    const record = await this.sessionStore.load(
      input.handle.acpxRecordId ?? input.handle.sessionKey,
    );
    const delegate = this.resolveDelegateForLoadedRecord(input.handle, record);
    await delegate.cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.sessionStore.markFresh(input.sessionKey);
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    const record = await this.sessionStore.load(
      input.handle.acpxRecordId ?? input.handle.sessionKey,
    );
    let closeSucceeded = false;
    try {
      await this.resolveDelegateForLoadedRecord(input.handle, record).close({
        handle: input.handle,
        reason: input.reason,
        discardPersistentState: input.discardPersistentState,
      });
      closeSucceeded = true;
    } finally {
      await this.cleanupProcessTreeForRecord(input.handle, record);
    }
    if (closeSucceeded && input.discardPersistentState) {
      this.sessionStore.markFresh(input.handle.sessionKey);
    }
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

export const __testing = {
  appendCodexAcpConfigOverrides,
  assertSupportedRuntimeSessionMode,
  codexAcpSessionModelId,
  isClaudeAcpCommand,
  isCodexAcpCommand,
  normalizeCodexAcpModelOverride,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
