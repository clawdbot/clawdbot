/**
 * OpenClaw ACPX runtime adapter. It wraps the upstream acpx runtime with
 * OpenClaw session metadata, lease tracking, model scoping, and cleanup policy.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path, { resolve as resolvePath } from "node:path";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  isRequestedModelUnsupportedError,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnResult,
  type SessionAgentOptions,
} from "acpx/runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { AcpRuntimeError, type AcpRuntime, type AcpRuntimeErrorCode } from "../runtime-api.js";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { splitCommandParts } from "./command-line.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  createAcpxProcessLeaseId,
  hashAcpxProcessCommand,
  readAcpxProcessLeaseIdentity,
  withAcpxLeaseEnvironment,
  type AcpxProcessLease,
  type AcpxProcessLeaseIdentity,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawLeaseAwareAcpxProcessCommand,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";
import type { CompleteAcpRuntime, CompleteAcpRuntimeTurn } from "./runtime-proxy.js";

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;
type BaseAcpxRuntimeTestOptions = ConstructorParameters<typeof BaseAcpxRuntime>[1];
type OpenClawAcpxRuntimeOptions = AcpRuntimeOptions & {
  openclawWrapperRoot?: string;
  openclawGatewayInstanceId?: string;
  openclawProcessLeaseStore?: AcpxProcessLeaseStore;
  pluginToolsMcpBridgeEnabled?: boolean;
  openclawToolsMcpBridgeEnabled?: boolean;
};
type AcpxRuntimeTestOptions = Record<string, unknown> & {
  openclawProcessCleanup?: AcpxProcessCleanupDeps;
};
type OpenClawRuntimeTurnInput = Parameters<NonNullable<AcpRuntime["startTurn"]>>[0];
type OpenClawRuntimeEnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];
type OpenClawRuntimeHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
type AcpxDelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];
type AcpxMcpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";
type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

type OpenClawLeaseSessionMetadata = {
  openclawLeaseId: string;
  openclawGatewayInstanceId: string;
};

function withOpenClawManagedTurnTimeout<T extends object>(input: T): T & { timeoutMs: 0 } {
  // OpenClaw owns ACP turn deadlines. acpx treats timeout after partial agent
  // output as a completed turn, which can mark background work done early.
  return {
    ...input,
    timeoutMs: 0,
  };
}

function withOpenClawLeaseSessionMetadata<T extends object>(
  record: T,
  metadata: OpenClawLeaseSessionMetadata,
): T & OpenClawLeaseSessionMetadata {
  return {
    ...record,
    openclawLeaseId: metadata.openclawLeaseId,
    openclawGatewayInstanceId: metadata.openclawGatewayInstanceId,
  };
}

type AcpxLaunchLeaseContext = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  stableCommand: string;
  resolvedCommand: string;
  leasedCommand: string;
};

type AcpxHandleOperationSnapshot = Readonly<{
  record: AcpLoadedSessionRecord;
  command: string | undefined;
}>;

const CODEX_WRAPPER_STDERR_LOG_PREFIX = "codex-acp-wrapper.stderr";
const CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS = 6_000;

function safeDiagnosticFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function codexWrapperStderrLogFileName(leaseId: string): string {
  return `${CODEX_WRAPPER_STDERR_LOG_PREFIX}.${safeDiagnosticFilePart(leaseId)}.log`;
}

function compactDiagnosticText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericInternalAcpErrorMessage(message: string): boolean {
  return message.trim() === "Internal error";
}

function isGenericInternalAcpError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return isGenericInternalAcpErrorMessage(error.message);
}

async function readCodexWrapperStderrTail(params: {
  wrapperRoot: string | undefined;
  leaseId: string | undefined;
}): Promise<string> {
  if (!params.wrapperRoot || !params.leaseId) {
    return "";
  }
  try {
    const text = await fs.readFile(
      path.join(params.wrapperRoot, codexWrapperStderrLogFileName(params.leaseId)),
      "utf8",
    );
    return compactDiagnosticText(
      redactSensitiveText(sliceUtf16Safe(text, -CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS)),
    );
  } catch {
    return "";
  }
}

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
        ? parseStrictPositiveInteger(rawPid)
        : undefined;
  return numericPid && Number.isInteger(numericPid) && numericPid > 0 ? numericPid : undefined;
}

function readOpenClawLeaseIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { openclawLeaseId } = record as { openclawLeaseId?: unknown };
  return typeof openclawLeaseId === "string" ? openclawLeaseId.trim() || undefined : undefined;
}

function readOpenClawGatewayInstanceIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { openclawGatewayInstanceId } = record as { openclawGatewayInstanceId?: unknown };
  return typeof openclawGatewayInstanceId === "string"
    ? openclawGatewayInstanceId.trim() || undefined
    : undefined;
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
  const sessionKeys = new Set(normalizeStringEntries(params.sessionKeys));
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
    wrapperRoot?: string;
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
      return withOpenClawLeaseSessionMetadata(record, {
        openclawLeaseId: lease.leaseId,
        openclawGatewayInstanceId: lease.gatewayInstanceId,
      });
    },
    async save(record: AcpSessionRecord): Promise<void> {
      let recordToSave = record;
      const launch = params?.launchScope?.getStore();
      const sessionName = readSessionRecordName(record);
      const agentCommand = readRecordAgentCommand(record);
      const leasedCommand = launch?.leasedCommand ?? agentCommand;
      const leaseIdentity = launch ?? readAcpxProcessLeaseIdentity(leasedCommand);
      if (
        params?.leaseStore &&
        params.gatewayInstanceId &&
        params.wrapperRoot &&
        (!launch || sessionName === launch.sessionKey) &&
        leasedCommand &&
        leaseIdentity?.gatewayInstanceId === params.gatewayInstanceId &&
        isOpenClawLeaseAwareAcpxProcessCommand({
          command: leasedCommand,
          wrapperRoot: params.wrapperRoot,
        })
      ) {
        const existing = await params.leaseStore.load(leaseIdentity.leaseId);
        const ownsExisting =
          !existing ||
          (existing.gatewayInstanceId === leaseIdentity.gatewayInstanceId &&
            existing.sessionKey === sessionName &&
            existing.wrapperRoot === params.wrapperRoot);
        if (ownsExisting) {
          const adoptingLease = Boolean(launch && launch.resolvedCommand !== launch.leasedCommand);
          const lifecycleRecord = adoptingLease
            ? {
                ...record,
                // A reused legacy record can carry the previous wrapper PID. Clear
                // it before persisting the new lease so reconnect cannot claim it.
                pid: undefined,
                processId: undefined,
                agentStartedAt: undefined,
              }
            : record;
          const rootPid = readRecordAgentPid(lifecycleRecord);
          if (rootPid) {
            await params.leaseStore.save({
              leaseId: leaseIdentity.leaseId,
              gatewayInstanceId: leaseIdentity.gatewayInstanceId,
              sessionKey: sessionName,
              wrapperRoot: params.wrapperRoot,
              wrapperPath: extractGeneratedWrapperPath(leasedCommand),
              rootPid,
              ...(existing?.rootPid === rootPid && existing.processGroupId
                ? { processGroupId: existing.processGroupId }
                : {}),
              commandHash: hashAcpxProcessCommand(leasedCommand),
              startedAt: existing?.rootPid === rootPid ? existing.startedAt : Date.now(),
              state: "open",
            });
          }
          recordToSave = withOpenClawLeaseSessionMetadata(
            {
              ...lifecycleRecord,
              // ACPX reconnects from the persisted command, so lease identity must
              // remain in that reuse key until the session lifecycle is terminal.
              agentCommand: leasedCommand,
            },
            {
              openclawLeaseId: leaseIdentity.leaseId,
              openclawGatewayInstanceId: leaseIdentity.gatewayInstanceId,
            },
          );
        }
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
const CODEX_ACP_OPENCLAW_PREFIX = "openai/";
const CLAUDE_ACP_OPENCLAW_PREFIX = "anthropic/";
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

type CodexAcpModelClassification =
  | { kind: "override"; override: CodexAcpModelOverride }
  | { kind: "unsupported"; thinkingOverride?: CodexAcpModelOverride };

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

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function unwrapEnvCommand(parts: string[]): string[] {
  const command = parts.at(0);
  if (!command || basename(command) !== "env") {
    return parts;
  }
  let index = 1;
  while (true) {
    const part = parts.at(index);
    if (!part || !isEnvAssignment(part)) {
      break;
    }
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
    packageName: CODEX_ACP_PACKAGE,
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
      `Codex ACP model "${rawModel}" is not supported. Use openai/<model> or <model>/<reasoning-effort>.`,
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

function isCodexAcpReasoningEffortAlias(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && CODEX_ACP_THINKING_ALIASES.has(normalized));
}

function classifyCodexAcpModelRequest(
  rawModel: string | undefined,
  rawThinking?: string,
): CodexAcpModelClassification {
  const raw = rawModel?.trim();
  const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);
  const thinkingOnlyOverride = thinkingReasoningEffort
    ? { reasoningEffort: thinkingReasoningEffort }
    : undefined;
  if (!raw) {
    return { kind: "override", override: thinkingOnlyOverride ?? {} };
  }

  let value = raw;
  let hadOpenAiQualifier = false;
  if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) {
    value = value.slice(CODEX_ACP_OPENCLAW_PREFIX.length);
    hadOpenAiQualifier = true;
  }

  let model = value.trim();
  let modelReasoningEffort: string | undefined;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && isCodexAcpReasoningEffortAlias(value.slice(slashIndex + 1))) {
    modelReasoningEffort = normalizeCodexAcpReasoningEffort(value.slice(slashIndex + 1));
    model = value.slice(0, slashIndex).trim();
  }

  if (hadOpenAiQualifier && (!model || model.includes("/"))) {
    failUnsupportedCodexAcpModel(
      raw,
      `Codex ACP model "${raw}" is not supported. Use openai/<model> or <model>/<reasoning-effort>.`,
    );
  }
  if (!model || model.includes("/")) {
    return thinkingOnlyOverride
      ? { kind: "unsupported", thinkingOverride: thinkingOnlyOverride }
      : { kind: "unsupported" };
  }

  const reasoningEffort = thinkingReasoningEffort ?? modelReasoningEffort;
  return {
    kind: "override",
    override: {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

function withCodexSessionModel<T extends { model?: string }>(
  input: T,
  override: CodexAcpModelOverride | undefined,
): T {
  const next = { ...input };
  if (override?.model) {
    next.model = override.model;
  } else {
    delete next.model;
  }
  return next;
}

function normalizeClaudeAcpModelOverride(rawModel: string | undefined): string | undefined {
  const raw = rawModel?.trim();
  if (!raw) {
    return undefined;
  }
  if (!raw.toLowerCase().startsWith(CLAUDE_ACP_OPENCLAW_PREFIX)) {
    return raw;
  }
  return raw.slice(CLAUDE_ACP_OPENCLAW_PREFIX.length).trim() || undefined;
}

function withAcpxSessionOptions(input: OpenClawRuntimeEnsureInput): AcpxDelegateEnsureInput {
  const existingOptions = (input as { sessionOptions?: SessionAgentOptions }).sessionOptions;
  const model = input.model?.trim() || existingOptions?.model;
  const sessionOptions = model ? { ...existingOptions, model } : existingOptions;
  const { modelExplicit: _modelExplicit, ...rest } = input;
  return {
    ...rest,
    ...(sessionOptions ? { sessionOptions } : {}),
  } as AcpxDelegateEnsureInput;
}

function isAcpModelCapabilityMissingError(error: unknown): boolean {
  return isRequestedModelUnsupportedError(error) && error.reason === "missing-capability";
}

// ACPX owns the distinction between missing model capability and an invalid model id.
// Retry only the former so explicit model mistakes remain visible to the caller.
async function ensureDelegateSessionWithModelFallback(
  delegate: BaseAcpxRuntime,
  input: OpenClawRuntimeEnsureInput,
): Promise<AcpRuntimeHandle> {
  try {
    return await delegate.ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    if (!input.model || !isAcpModelCapabilityMissingError(error)) {
      throw error;
    }
    return await delegate.ensureSession(withAcpxSessionOptions({ ...input, model: undefined }));
  }
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeAgentCommand(command: string | string[]): string | undefined {
  const normalized = Array.isArray(command)
    ? command.map((part) => quoteShellArg(part)).join(" ")
    : command;
  return normalized.trim() || undefined;
}

function appendCodexAcpConfigOverrides(command: string, override: CodexAcpModelOverride): string {
  const config = {
    ...(override.model ? { model: override.model } : {}),
    ...(override.reasoningEffort ? { model_reasoning_effort: override.reasoningEffort } : {}),
  };
  if (Object.keys(config).length === 0) {
    return command;
  }
  return `${command} ${OPENCLAW_CODEX_CONFIG_ARG} ${quoteShellArg(JSON.stringify(config))}`;
}

function createModelScopedAgentRegistry(params: {
  agentRegistry: AcpAgentRegistry;
  scope: AsyncLocalStorage<CodexAcpModelOverride | undefined>;
  leaseCommand: (command: string) => string;
}): AcpAgentRegistry {
  return {
    resolve(agentName: string): string {
      const command = normalizeAgentCommand(params.agentRegistry.resolve(agentName)) ?? "";
      const override = params.scope.getStore();
      if (
        !override ||
        normalizeAgentName(agentName) !== CODEX_ACP_AGENT_ID ||
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
  return normalizeAgentCommand(params.agentRegistry.resolve(normalizedAgentName));
}

function shouldUseBridgeSafeDelegateForCommand(command: string | undefined): boolean {
  return isOpenClawBridgeCommand(command);
}

function shouldUseDistinctBridgeDelegate(options: AcpRuntimeOptions): boolean {
  const { mcpServers } = options as { mcpServers?: unknown };
  return Array.isArray(mcpServers) && mcpServers.length > 0;
}

function withManagedToolsMcpSessionEnv(params: {
  pluginToolsEnabled: boolean;
  openclawToolsEnabled: boolean;
  mcpServers: AcpRuntimeOptions["mcpServers"];
  sessionKey: string;
}): AcpRuntimeOptions["mcpServers"] {
  const sessionKey = params.sessionKey.trim();
  if (
    (!params.pluginToolsEnabled && !params.openclawToolsEnabled) ||
    !sessionKey ||
    !params.mcpServers?.length
  ) {
    return params.mcpServers;
  }
  let changed = false;
  const nextServers = params.mcpServers.map((server): AcpxMcpServer => {
    const isManagedPluginTools =
      params.pluginToolsEnabled && server.name === ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME;
    const isManagedOpenClawTools =
      params.openclawToolsEnabled && server.name === ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME;
    if ((!isManagedPluginTools && !isManagedOpenClawTools) || !("command" in server)) {
      return server;
    }
    changed = true;
    const env = [
      ...server.env.filter((entry) => entry.name !== OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV),
      {
        name: OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
        value: sessionKey,
      },
    ];
    return { ...server, env };
  });
  return changed ? nextServers : params.mcpServers;
}

/** OpenClaw-managed ACP runtime implementation backed by the upstream acpx runtime. */
export class AcpxRuntime implements CompleteAcpRuntime {
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly agentRegistry: AcpAgentRegistry;
  private readonly scopedAgentRegistry: AcpAgentRegistry;
  private readonly codexAcpModelOverrideScope = new AsyncLocalStorage<
    CodexAcpModelOverride | undefined
  >();
  private readonly delegate: BaseAcpxRuntime;
  private readonly bridgeSafeDelegate: BaseAcpxRuntime;
  private readonly probeDelegate: BaseAcpxRuntime;
  private readonly probeCommand: string | undefined;
  private readonly delegateOptions: AcpRuntimeOptions;
  private readonly delegateTestOptions: BaseAcpxRuntimeTestOptions;
  private readonly pluginToolsMcpBridgeEnabled: boolean;
  private readonly openclawToolsMcpBridgeEnabled: boolean;
  private readonly managedToolsMcpBridgeEnabled: boolean;
  private readonly managedToolsSessionDelegates = new Map<string, BaseAcpxRuntime>();
  private readonly processCleanupDeps: AcpxProcessCleanupDeps | undefined;
  private readonly wrapperRoot: string | undefined;
  private readonly gatewayInstanceId: string | undefined;
  private readonly processLeaseStore: AcpxProcessLeaseStore | undefined;
  private readonly launchLeaseScope = new AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>();
  private readonly ensureSessionTails = new Map<string, Promise<void>>();
  private readonly processLeaseTransitionTails = new Map<string, Promise<void>>();
  private readonly processLeaseOperationCounts = new Map<string, number>();
  private readonly uncertainProcessLeaseIds = new Set<string>();
  private readonly cwd: string;

  constructor(options: OpenClawAcpxRuntimeOptions, testOptions?: AcpxRuntimeTestOptions) {
    const { openclawProcessCleanup, ...delegateTestOptions } = testOptions ?? {};
    this.processCleanupDeps = openclawProcessCleanup;
    this.wrapperRoot = options.openclawWrapperRoot;
    this.gatewayInstanceId = options.openclawGatewayInstanceId;
    this.processLeaseStore = options.openclawProcessLeaseStore;
    this.pluginToolsMcpBridgeEnabled = options.pluginToolsMcpBridgeEnabled === true;
    this.openclawToolsMcpBridgeEnabled = options.openclawToolsMcpBridgeEnabled === true;
    this.managedToolsMcpBridgeEnabled =
      this.pluginToolsMcpBridgeEnabled || this.openclawToolsMcpBridgeEnabled;
    this.cwd = options.cwd;
    this.sessionStore = createResetAwareSessionStore(options.sessionStore, {
      gatewayInstanceId: this.gatewayInstanceId,
      leaseStore: this.processLeaseStore,
      launchScope: this.launchLeaseScope,
      wrapperRoot: this.wrapperRoot,
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
    this.delegateOptions = sharedOptions;
    this.delegateTestOptions = delegateTestOptions as BaseAcpxRuntimeTestOptions;
    this.delegate = new BaseAcpxRuntime(sharedOptions, this.delegateTestOptions);
    this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options)
      ? new BaseAcpxRuntime(
          {
            ...sharedOptions,
            mcpServers: [],
          },
          this.delegateTestOptions,
        )
      : this.delegate;
    const probeCommand = resolveAgentCommand({
      agentName: normalizeAgentName(options.probeAgent) ?? "codex",
      agentRegistry: this.agentRegistry,
    });
    this.probeCommand = probeCommand;
    const useBridgeSafeProbe =
      this.managedToolsMcpBridgeEnabled || shouldUseBridgeSafeDelegateForCommand(probeCommand);
    this.probeDelegate = useBridgeSafeProbe ? this.bridgeSafeDelegate : this.delegate;
  }

  private resolveDelegateForSession(params: {
    command: string | undefined;
    sessionKey: string;
  }): BaseAcpxRuntime {
    if (shouldUseBridgeSafeDelegateForCommand(params.command)) {
      return this.bridgeSafeDelegate;
    }
    return this.resolveManagedToolsDelegateForSession(params.sessionKey);
  }

  private resolveManagedToolsDelegateForSession(sessionKey: string): BaseAcpxRuntime {
    if (!this.managedToolsMcpBridgeEnabled) {
      return this.delegate;
    }
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return this.delegate;
    }
    const cached = this.managedToolsSessionDelegates.get(normalizedSessionKey);
    if (cached) {
      return cached;
    }
    // Upstream acpx captures mcpServers at runtime construction. Managed tool
    // bridges need per-session identity, so cache one delegate
    // per session with the scoped MCP env already embedded.
    const delegate = new BaseAcpxRuntime(
      {
        ...this.delegateOptions,
        mcpServers: withManagedToolsMcpSessionEnv({
          pluginToolsEnabled: this.pluginToolsMcpBridgeEnabled,
          openclawToolsEnabled: this.openclawToolsMcpBridgeEnabled,
          mcpServers: this.delegateOptions.mcpServers,
          sessionKey: normalizedSessionKey,
        }),
      },
      this.delegateTestOptions,
    );
    this.managedToolsSessionDelegates.set(normalizedSessionKey, delegate);
    return delegate;
  }

  private releaseManagedToolsDelegateForSession(sessionKey: string): void {
    if (!this.managedToolsMcpBridgeEnabled) {
      return;
    }
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return;
    }
    this.managedToolsSessionDelegates.delete(normalizedSessionKey);
  }

  private async loadOperationSnapshotForHandle(
    handle: AcpRuntimeHandle,
  ): Promise<AcpxHandleOperationSnapshot> {
    const record = await this.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
    const command =
      readAgentCommandFromRecord(record) ??
      resolveAgentCommand({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    return {
      record,
      command,
    };
  }

  private resolveDelegateForOperationSnapshot(
    handle: AcpRuntimeHandle,
    snapshot: AcpxHandleOperationSnapshot,
  ): BaseAcpxRuntime {
    // Lease-owning callers project only after validation so a rejected record
    // cannot populate the managed-tools delegate cache.
    return this.resolveDelegateForSession({
      command: snapshot.command,
      sessionKey: handle.sessionKey,
    });
  }

  private commandWithLaunchLease(command: string): string {
    const launch = this.launchLeaseScope.getStore();
    if (!launch) {
      return command;
    }
    if (command === launch.stableCommand) {
      return launch.resolvedCommand;
    }
    return withAcpxLeaseEnvironment({
      command,
      leaseId: launch.leaseId,
      gatewayInstanceId: launch.gatewayInstanceId,
    });
  }

  private async readReusablePersistentSessionCommand(params: {
    sessionKey: string;
    mode: Parameters<AcpRuntime["ensureSession"]>[0]["mode"];
    cwd: string | undefined;
    command: string | undefined;
    resumeSessionId: string | undefined;
  }): Promise<string | undefined> {
    if (params.mode !== "persistent" || !params.command) {
      return undefined;
    }
    const existing = await this.sessionStore.load(params.sessionKey);
    if (!existing || readRecordResetOnNextEnsure(existing)) {
      return undefined;
    }
    const recordCwd = readRecordCwd(existing);
    if (!recordCwd || resolvePath(recordCwd) !== resolvePath(params.cwd?.trim() || this.cwd)) {
      return undefined;
    }
    const recordCommand = readRecordAgentCommand(existing);
    if (!recordCommand) {
      return undefined;
    }
    const leaseIdentity = readAcpxProcessLeaseIdentity(recordCommand);
    if (leaseIdentity && leaseIdentity.gatewayInstanceId !== this.gatewayInstanceId) {
      return undefined;
    }
    const stableRecordCommand = leaseIdentity
      ? withAcpxLeaseEnvironment({
          command: params.command,
          leaseId: leaseIdentity.leaseId,
          gatewayInstanceId: leaseIdentity.gatewayInstanceId,
        })
      : params.command;
    if (recordCommand !== stableRecordCommand) {
      return undefined;
    }
    const existingSessionId =
      typeof existing === "object" && existing !== null
        ? (existing as { acpSessionId?: unknown }).acpSessionId
        : undefined;
    return !params.resumeSessionId || existingSessionId === params.resumeSessionId
      ? recordCommand
      : undefined;
  }

  private async runWithLaunchLease<T>(params: {
    sessionKey: string;
    command: string | undefined;
    reusableCommand?: string;
    finalizeCompletedProbe?: boolean;
    run: () => Promise<T>;
  }): Promise<T> {
    if (
      !params.command ||
      !this.wrapperRoot ||
      !this.gatewayInstanceId ||
      !this.processLeaseStore ||
      !isOpenClawLeaseAwareAcpxProcessCommand({
        command: params.command,
        wrapperRoot: this.wrapperRoot,
      })
    ) {
      return await params.run();
    }
    const processLeaseStore = this.processLeaseStore;
    const reusableIdentity = readAcpxProcessLeaseIdentity(params.reusableCommand);
    const canReuseLeaseIdentity = reusableIdentity?.gatewayInstanceId === this.gatewayInstanceId;
    // Repeated probes share one uncertainty row per Gateway and wrapper. Unique probe rows could
    // otherwise evict live session ownership from the bounded lease namespace.
    const leaseId = canReuseLeaseIdentity
      ? reusableIdentity.leaseId
      : params.finalizeCompletedProbe
        ? `probe-${hashAcpxProcessCommand(
            `${this.gatewayInstanceId}\0${extractGeneratedWrapperPath(params.command)}`,
          )}`
        : createAcpxProcessLeaseId();
    const leasedCommand = withAcpxLeaseEnvironment({
      command: params.command,
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
    });
    const launch: AcpxLaunchLeaseContext = {
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
      sessionKey: params.sessionKey,
      wrapperRoot: this.wrapperRoot,
      stableCommand: params.command,
      resolvedCommand: params.reusableCommand ?? leasedCommand,
      leasedCommand,
    };
    // Reuse-only adoption cannot spawn: readReusablePersistentSessionCommand
    // mirrors upstream's exact reuse policy. Persist the new command first and
    // let the next reconnect create its matching pending lease.
    await this.retainProcessLeaseOperation(launch, async () => {
      const reusableLease = canReuseLeaseIdentity
        ? await processLeaseStore.load(launch.leaseId)
        : undefined;
      if (
        reusableLease &&
        (reusableLease.gatewayInstanceId !== launch.gatewayInstanceId ||
          reusableLease.sessionKey !== launch.sessionKey ||
          reusableLease.wrapperRoot !== launch.wrapperRoot)
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `ACPX process lease ${launch.leaseId} belongs to another session`,
        );
      }
      const ownsPendingLease =
        !reusableLease && (!params.reusableCommand || params.reusableCommand === leasedCommand);
      if (!ownsPendingLease) {
        return;
      }
      // The pending lease is written before acpx can spawn. The session-store
      // save fills in the PID; uncertain launch failures leave it for recovery.
      await processLeaseStore.save({
        leaseId: launch.leaseId,
        gatewayInstanceId: launch.gatewayInstanceId,
        sessionKey: launch.sessionKey,
        wrapperRoot: launch.wrapperRoot,
        wrapperPath: extractGeneratedWrapperPath(leasedCommand),
        rootPid: 0,
        commandHash: hashAcpxProcessCommand(leasedCommand),
        startedAt: Date.now(),
        state: "open",
      });
    });
    try {
      const result = await this.launchLeaseScope.run(launch, params.run);
      if (params.finalizeCompletedProbe) {
        await this.finalizeCompletedProbeLease(launch);
      } else {
        await this.finalizeProcessLeaseForSession(params.sessionKey, launch);
      }
      return result;
    } catch (error) {
      await this.releaseProcessLeaseAfterUncertainFailure(launch);
      throw error;
    }
  }

  private async prepareProcessLeaseForOperation(
    handle: AcpRuntimeHandle,
    record: AcpLoadedSessionRecord,
  ): Promise<AcpxProcessLeaseIdentity | undefined> {
    if (!this.processLeaseStore || !this.gatewayInstanceId || !this.wrapperRoot) {
      return undefined;
    }
    const processLeaseStore = this.processLeaseStore;
    const wrapperRoot = this.wrapperRoot;
    const recordPid = readRecordAgentPid(record);
    const command = readAgentCommandFromRecord(record);
    const identity = readAcpxProcessLeaseIdentity(command);
    if (
      !command ||
      !isOpenClawLeaseAwareAcpxProcessCommand({
        command,
        wrapperRoot,
      })
    ) {
      return undefined;
    }
    if (!identity) {
      return undefined;
    }
    if (identity.gatewayInstanceId !== this.gatewayInstanceId) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        `ACPX process lease ${identity.leaseId} belongs to another gateway`,
      );
    }
    await this.retainProcessLeaseOperation(identity, async () => {
      const existing = await processLeaseStore.load(identity.leaseId);
      if (!existing) {
        // Preserve a PID already persisted with this lease identity. Otherwise
        // reconnect starts from a pending row until upstream saves its new PID.
        await processLeaseStore.save({
          leaseId: identity.leaseId,
          gatewayInstanceId: identity.gatewayInstanceId,
          sessionKey: handle.sessionKey,
          wrapperRoot,
          wrapperPath: extractGeneratedWrapperPath(command),
          rootPid: recordPid ?? 0,
          commandHash: hashAcpxProcessCommand(command),
          startedAt: Date.now(),
          state: "open",
        });
        return;
      }
      if (
        existing.gatewayInstanceId !== identity.gatewayInstanceId ||
        existing.sessionKey !== handle.sessionKey ||
        existing.wrapperRoot !== wrapperRoot
      ) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACPX process lease ${identity.leaseId} belongs to another session`,
        );
      }
    });
    return identity;
  }

  private async runSerializedProcessLeaseTransition<T>(
    leaseId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.processLeaseTransitionTails.get(leaseId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.processLeaseTransitionTails.set(leaseId, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.processLeaseTransitionTails.get(leaseId) === tail) {
        this.processLeaseTransitionTails.delete(leaseId);
      }
    }
  }

  private async retainProcessLeaseOperation(
    identity: AcpxProcessLeaseIdentity,
    prepare: () => Promise<void>,
  ): Promise<void> {
    await this.runSerializedProcessLeaseTransition(identity.leaseId, async () => {
      await prepare();
      this.processLeaseOperationCounts.set(
        identity.leaseId,
        (this.processLeaseOperationCounts.get(identity.leaseId) ?? 0) + 1,
      );
    });
  }

  private async releaseProcessLeaseOperation(
    identity: AcpxProcessLeaseIdentity | undefined,
    finalize: () => Promise<void>,
  ): Promise<void> {
    if (!identity) {
      return;
    }
    await this.runSerializedProcessLeaseTransition(identity.leaseId, async () => {
      const count = this.processLeaseOperationCounts.get(identity.leaseId) ?? 0;
      if (count > 1) {
        this.processLeaseOperationCounts.set(identity.leaseId, count - 1);
        return;
      }
      if (count === 0) {
        return;
      }
      // Keep the zero-owner check and retirement in one lease-local transition.
      // Otherwise a reconnect can retain a row while an older owner deletes it.
      this.processLeaseOperationCounts.delete(identity.leaseId);
      await finalize();
    });
  }

  private async finalizeProcessLeaseForOperation(
    handle: AcpRuntimeHandle,
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    await this.finalizeProcessLeaseForSession(handle.acpxRecordId ?? handle.sessionKey, identity);
  }

  private async finalizeProcessLeaseForSession(
    sessionId: string,
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    if (!identity || !this.processLeaseStore) {
      return;
    }
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId) {
        return;
      }
      if (lease.rootPid <= 0) {
        if (this.uncertainProcessLeaseIds.has(identity.leaseId)) {
          return;
        }
        await processLeaseStore.markState(identity.leaseId, "lost");
        return;
      }
      this.uncertainProcessLeaseIds.delete(identity.leaseId);
      try {
        const record = await this.sessionStore.load(sessionId);
        const recordIdentity = readAcpxProcessLeaseIdentity(readAgentCommandFromRecord(record));
        if (
          recordIdentity?.leaseId !== identity.leaseId ||
          recordIdentity.gatewayInstanceId !== identity.gatewayInstanceId
        ) {
          await processLeaseStore.markState(identity.leaseId, "lost");
        }
      } catch {
        // Preserve a PID-bearing lease for startup verification when record reload
        // fails; deleting it here could lose the only cleanup identity.
      }
    });
  }

  private async finalizeCompletedProbeLease(identity: AcpxLaunchLeaseContext): Promise<void> {
    if (!this.processLeaseStore) {
      return;
    }
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId) {
        return;
      }
      // Upstream probe close is bounded and best-effort. Delegate fulfillment
      // does not prove the wrapper exited, so verify the exact pending identity.
      // Keep the lease even when the wrapper is absent: its detached adapter
      // descendants do not carry lease args and may already be reparented.
      if (lease.rootPid > 0) {
        return;
      }
      await cleanupOpenClawOwnedAcpxPendingLease({
        leaseId: lease.leaseId,
        gatewayInstanceId: lease.gatewayInstanceId,
        wrapperRoot: lease.wrapperRoot,
        wrapperPath: lease.wrapperPath,
        deps: this.processCleanupDeps,
      });
    });
  }

  private async releaseProcessLeaseAfterUncertainFailure(
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    if (!identity || !this.processLeaseStore) {
      return;
    }
    this.uncertainProcessLeaseIds.add(identity.leaseId);
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId || lease.rootPid > 0) {
        this.uncertainProcessLeaseIds.delete(identity.leaseId);
      }
    });
  }

  private async runWithProcessLeaseForHandle<T>(
    handle: AcpRuntimeHandle,
    record: AcpLoadedSessionRecord,
    run: () => Promise<T>,
  ): Promise<T> {
    const identity = await this.prepareProcessLeaseForOperation(handle, record);
    try {
      return await run();
    } finally {
      await this.finalizeProcessLeaseForOperation(handle, identity);
    }
  }

  private async finalizeProcessLeaseAfter<T>(
    handle: AcpRuntimeHandle,
    identityPromise: Promise<AcpxProcessLeaseIdentity | undefined>,
    resultPromise: Promise<T>,
  ): Promise<T> {
    try {
      return await resultPromise;
    } finally {
      await this.finalizeProcessLeaseForOperation(handle, await identityPromise);
    }
  }

  private async runSerializedSessionEnsure<T>(
    sessionKey: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = sessionKey.trim() || sessionKey;
    const previous = this.ensureSessionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.ensureSessionTails.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.ensureSessionTails.get(key) === tail) {
        this.ensureSessionTails.delete(key);
      }
    }
  }

  private async withCodexWrapperDiagnostics<T>(params: {
    command: string | undefined;
    fallbackCode: AcpRuntimeErrorCode;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (error) {
      if (!isCodexAcpCommand(params.command) || !isGenericInternalAcpError(error)) {
        throw error;
      }
      const stderrTail = await readCodexWrapperStderrTail({
        wrapperRoot: this.wrapperRoot,
        leaseId: this.launchLeaseScope.getStore()?.leaseId,
      });
      if (!stderrTail) {
        throw error;
      }
      throw new AcpRuntimeError(params.fallbackCode, `Internal error: ${stderrTail}`, {
        cause: error,
      });
    }
  }

  private async readCodexTurnFailureStderr(params: { handle: AcpRuntimeHandle }): Promise<string> {
    const record = await this.sessionStore.load(
      params.handle.acpxRecordId ?? params.handle.sessionKey,
    );
    return readCodexWrapperStderrTail({
      wrapperRoot: this.wrapperRoot,
      leaseId: readOpenClawLeaseIdFromRecord(record),
    });
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
        result.skippedReason === "process-list-unavailable" ||
          result.skippedReason === "unsupported-platform"
          ? "open"
          : result.terminatedPids.length > 0 || result.skippedReason === "missing-root"
            ? "closed"
            : "lost",
      );
      return;
    }

    const rootCommand =
      readAgentCommandFromRecord(record) ??
      resolveAgentCommand({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    if (!rootPid || !rootCommand) {
      return;
    }
    const expectedGatewayInstanceId = readOpenClawGatewayInstanceIdFromRecord(record);
    await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid,
      rootCommand,
      ...(leaseId ? { expectedLeaseId: leaseId } : {}),
      ...(expectedGatewayInstanceId ? { expectedGatewayInstanceId } : {}),
      wrapperRoot: this.wrapperRoot,
      deps: this.processCleanupDeps,
    });
  }

  isHealthy(): boolean {
    return this.probeDelegate.isHealthy();
  }

  async probeAvailability(): Promise<void> {
    await this.runWithLaunchLease({
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      command: this.probeCommand,
      finalizeCompletedProbe: true,
      run: () => this.probeDelegate.probeAvailability(),
    });
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    return await this.runWithLaunchLease({
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      command: this.probeCommand,
      finalizeCompletedProbe: true,
      run: () => this.probeDelegate.doctor(),
    });
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    return await this.runSerializedSessionEnsure(input.sessionKey, () =>
      this.ensureSessionUnlocked(input),
    );
  }

  private async ensureSessionUnlocked(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    assertSupportedRuntimeSessionMode(input.mode);
    const command = resolveAgentCommand({
      agentName: input.agent,
      agentRegistry: this.agentRegistry,
    });
    const delegate = this.resolveDelegateForSession({ command, sessionKey: input.sessionKey });
    const isCodexAcp =
      normalizeAgentName(input.agent) === CODEX_ACP_AGENT_ID && isCodexAcpCommand(command);
    const claudeModelOverride = isClaudeAcpCommand(command)
      ? normalizeClaudeAcpModelOverride(input.model)
      : undefined;
    const codexClassification = isCodexAcp
      ? classifyCodexAcpModelRequest(input.model, input.thinking)
      : undefined;
    if (codexClassification?.kind === "unsupported" && input.modelExplicit) {
      failUnsupportedCodexAcpModel(input.model ?? "");
    }
    const classifiedCodexOverride =
      codexClassification?.kind === "override"
        ? codexClassification.override
        : codexClassification?.thinkingOverride;
    const codexModelOverride =
      classifiedCodexOverride && Object.keys(classifiedCodexOverride).length > 0
        ? classifiedCodexOverride
        : undefined;
    const requestedModel = input.model?.trim();
    const appliedModel: OpenClawRuntimeHandle["appliedModel"] =
      isCodexAcp && requestedModel
        ? codexModelOverride?.model
          ? { kind: "applied", model: requestedModel }
          : { kind: "dropped" }
        : undefined;
    const ensureInput = isCodexAcp
      ? withCodexSessionModel(input, codexModelOverride)
      : claudeModelOverride
        ? { ...input, model: claudeModelOverride }
        : input;
    const stableLaunchCommand =
      codexModelOverride && command
        ? appendCodexAcpConfigOverrides(command, codexModelOverride)
        : command;
    const reusableCommand = await this.readReusablePersistentSessionCommand({
      sessionKey: input.sessionKey,
      mode: input.mode,
      cwd: input.cwd,
      command: stableLaunchCommand,
      resumeSessionId: input.resumeSessionId,
    });

    const handle = !codexModelOverride
      ? await this.runWithLaunchLease({
          sessionKey: ensureInput.sessionKey,
          command: stableLaunchCommand,
          reusableCommand,
          run: () =>
            this.withCodexWrapperDiagnostics({
              command: stableLaunchCommand,
              fallbackCode: "ACP_SESSION_INIT_FAILED",
              run: () => ensureDelegateSessionWithModelFallback(delegate, ensureInput),
            }),
        })
      : await this.runWithLaunchLease({
          sessionKey: input.sessionKey,
          command: stableLaunchCommand,
          reusableCommand,
          run: () =>
            this.codexAcpModelOverrideScope.run(codexModelOverride, () =>
              this.withCodexWrapperDiagnostics({
                command: stableLaunchCommand,
                fallbackCode: "ACP_SESSION_INIT_FAILED",
                run: () => delegate.ensureSession(withAcpxSessionOptions(ensureInput)),
              }),
            ),
        });
    return appliedModel ? { ...handle, appliedModel } : handle;
  }

  async *runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    const record = await this.sessionStore.load(
      input.handle.acpxRecordId ?? input.handle.sessionKey,
    );
    const turnLease = await this.prepareProcessLeaseForOperation(input.handle, record);
    let command: string | undefined;
    try {
      // Legacy runTurn keeps separate command/delegate loads; startTurn owns the
      // one-snapshot contract until task #15 removes this compatibility path.
      command = (await this.loadOperationSnapshotForHandle(input.handle)).command;
      const delegate = this.resolveDelegateForOperationSnapshot(
        input.handle,
        await this.loadOperationSnapshotForHandle(input.handle),
      );
      for await (const event of delegate.runTurn(withOpenClawManagedTurnTimeout(input))) {
        if (
          event.type !== "error" ||
          !isCodexAcpCommand(command) ||
          !isGenericInternalAcpErrorMessage(event.message)
        ) {
          yield event;
          continue;
        }
        const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
        if (!stderrTail) {
          yield event;
          continue;
        }
        yield {
          ...event,
          code: "ACP_TURN_FAILED",
          message: `Internal error: ${stderrTail}`,
        };
      }
    } catch (error) {
      if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) {
        throw error;
      }
      const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
      if (!stderrTail) {
        throw error;
      }
      throw new AcpRuntimeError("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, {
        cause: error,
      });
    } finally {
      await this.finalizeProcessLeaseForOperation(input.handle, turnLease);
    }
  }

  startTurn(input: OpenClawRuntimeTurnInput): CompleteAcpRuntimeTurn {
    const readCodexTurnFailureStderr = () =>
      this.readCodexTurnFailureStderr({
        handle: input.handle,
      });
    const snapshotPromise = this.loadOperationSnapshotForHandle(input.handle);
    const turnLeasePromise = snapshotPromise.then(({ record }) =>
      this.prepareProcessLeaseForOperation(input.handle, record),
    );
    const turnPromise = Promise.all([snapshotPromise, turnLeasePromise]).then(
      async ([snapshot]) => {
        const { command } = snapshot;
        const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
        try {
          return {
            command,
            turn: delegate.startTurn(withOpenClawManagedTurnTimeout(input)),
          };
        } catch (error) {
          if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) {
            throw error;
          }
          const stderrTail = await readCodexTurnFailureStderr();
          if (!stderrTail) {
            throw error;
          }
          throw new AcpRuntimeError("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, {
            cause: error,
          });
        }
      },
    );

    return {
      requestId: input.requestId,
      get promptStarted() {
        return turnPromise.then(({ turn }) => turn.promptStarted);
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
          const { command, turn } = await turnPromise;
          try {
            for await (const event of turn.events) {
              if (
                event.type !== "error" ||
                !isCodexAcpCommand(command) ||
                !isGenericInternalAcpErrorMessage(event.message)
              ) {
                yield event;
                continue;
              }
              const stderrTail = await readCodexTurnFailureStderr();
              if (!stderrTail) {
                yield event;
                continue;
              }
              yield {
                ...event,
                code: "ACP_TURN_FAILED",
                message: `Internal error: ${stderrTail}`,
              };
            }
          } catch (error) {
            if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) {
              throw error;
            }
            const stderrTail = await readCodexTurnFailureStderr();
            if (!stderrTail) {
              throw error;
            }
            throw new AcpRuntimeError("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, {
              cause: error,
            });
          }
        },
      },
      result: this.finalizeProcessLeaseAfter(
        input.handle,
        turnLeasePromise,
        turnPromise.then(async ({ command, turn }): Promise<AcpRuntimeTurnResult> => {
          try {
            const result = await turn.result;
            if (
              result.status !== "failed" ||
              !isCodexAcpCommand(command) ||
              !isGenericInternalAcpErrorMessage(result.error.message)
            ) {
              return result;
            }
            const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
            if (!stderrTail) {
              return result;
            }
            return {
              status: "failed",
              error: {
                ...result.error,
                code: "ACP_TURN_FAILED",
                message: `Internal error: ${stderrTail}`,
              },
            };
          } catch (error) {
            if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) {
              throw error;
            }
            const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
            if (!stderrTail) {
              throw error;
            }
            throw new AcpRuntimeError("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, {
              cause: error,
            });
          }
        }),
      ),
      cancel(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.cancel(inputArgs));
      },
      closeStream(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.closeStream(inputArgs));
      },
    };
  }

  getCapabilities(
    input?: Parameters<NonNullable<AcpRuntime["getCapabilities"]>>[0],
  ): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities(input);
  }

  async getStatus(
    input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0],
  ): Promise<AcpRuntimeStatus> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    return this.resolveDelegateForOperationSnapshot(input.handle, snapshot).getStatus(input);
  }

  async setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    await this.runWithProcessLeaseForHandle(input.handle, snapshot.record, () =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).setMode(input),
    );
  }

  async setConfigOption(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
  ): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    await this.runWithProcessLeaseForHandle(input.handle, snapshot.record, () =>
      this.setConfigOptionUnlocked(input, snapshot),
    );
  }

  private async setConfigOptionUnlocked(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
    snapshot: AcpxHandleOperationSnapshot,
  ): Promise<void> {
    const { command } = snapshot;
    const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
    const key = input.key.trim().toLowerCase();
    const isCodexAcp = isCodexAcpCommand(command);
    if (WIRE_TIMEOUT_CONFIG_KEYS.has(key) && (isCodexAcp || isClaudeAcpCommand(command))) {
      return;
    }
    if (isCodexAcp) {
      if (key === "model") {
        const classification = classifyCodexAcpModelRequest(input.value);
        if (classification.kind === "unsupported") {
          failUnsupportedCodexAcpModel(input.value);
        }
        const { override } = classification;
        if (override.model) {
          await delegate.setConfigOption({ ...input, key: "model", value: override.model });
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
      if (key === "thinking" || key === "thought_level" || key === "reasoning_effort") {
        const classification = classifyCodexAcpModelRequest(undefined, input.value);
        const reasoningEffort =
          classification.kind === "override" ? classification.override.reasoningEffort : undefined;
        if (!reasoningEffort) {
          return;
        }
        await delegate.setConfigOption({
          ...input,
          key: "reasoning_effort",
          value: reasoningEffort,
        });
        return;
      }
    }
    if (isClaudeAcpCommand(command) && key === "model") {
      await delegate.setConfigOption({
        ...input,
        value: normalizeClaudeAcpModelOverride(input.value) ?? input.value,
      });
      return;
    }
    await delegate.setConfigOption(input);
  }

  async cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    await this.resolveDelegateForOperationSnapshot(input.handle, snapshot).cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    // Fresh reset has no ACP handle to close the delegate's upstream client.
    // Keep the scoped delegate reachable so the next ensure can replace it;
    // close() owns cache release when the session lifecycle ends.
    this.sessionStore.markFresh(input.sessionKey);
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    const closeLease = await this.prepareProcessLeaseForOperation(input.handle, snapshot.record);
    let cleanupSucceeded = false;
    try {
      const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
      let closeSucceeded;
      try {
        await delegate.close({
          handle: input.handle,
          reason: input.reason,
          discardPersistentState: input.discardPersistentState,
        });
        closeSucceeded = true;
      } finally {
        await this.cleanupProcessTreeForRecord(input.handle, snapshot.record);
        cleanupSucceeded = true;
      }
      if (closeSucceeded) {
        this.releaseManagedToolsDelegateForSession(input.handle.sessionKey);
      }
      if (closeSucceeded && input.discardPersistentState) {
        this.sessionStore.markFresh(input.handle.sessionKey);
      }
    } finally {
      if (cleanupSucceeded) {
        await this.finalizeProcessLeaseForOperation(input.handle, closeLease);
      } else {
        await this.releaseProcessLeaseAfterUncertainFailure(closeLease);
      }
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

/** Test-only hooks for ACPX runtime behavior that is otherwise private. */
export const testing = {
  appendCodexAcpConfigOverrides,
  isClaudeAcpCommand,
  isCodexAcpCommand,
  normalizeAgentCommand,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
