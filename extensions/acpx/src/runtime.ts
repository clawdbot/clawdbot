import { AsyncLocalStorage } from "node:async_hooks";
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

type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;

type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
};

function readSessionRecordName(record: AcpSessionRecord): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

function createResetAwareSessionStore(baseStore: AcpSessionStore): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const normalized = sessionId.trim();
      if (normalized && freshSessionKeys.has(normalized)) {
        return undefined;
      }
      return await baseStore.load(sessionId);
    },
    async save(record: AcpSessionRecord): Promise<void> {
      await baseStore.save(record);
      const sessionName = readSessionRecordName(record);
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
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { agentCommand } = record as { agentCommand?: unknown };
  return typeof agentCommand === "string" ? agentCommand.trim() || undefined : undefined;
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

function isCodexAcpPackageSpec(value: string): boolean {
  return /^@zed-industries\/codex-acp(?:@.+)?$/i.test(value.trim());
}

function isCodexAcpCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command.trim()));
  if (!parts.length) {
    return false;
  }
  if (parts.some(isCodexAcpPackageSpec)) {
    return true;
  }
  const commandName = basename(parts[0] ?? "");
  if (/^codex-acp(?:\.exe)?$/i.test(commandName)) {
    return true;
  }
  if (commandName !== "node") {
    return false;
  }
  const scriptName = basename(parts[1] ?? "");
  return /^codex-acp(?:-wrapper)?(?:\.[cm]?js)?$/i.test(scriptName);
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
        return command;
      }
      return appendCodexAcpConfigOverrides(command, override);
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

  constructor(
    options: AcpRuntimeOptions,
    testOptions?: ConstructorParameters<typeof BaseAcpxRuntime>[1],
  ) {
    this.sessionStore = createResetAwareSessionStore(options.sessionStore);
    this.agentRegistry = options.agentRegistry;
    this.scopedAgentRegistry = createModelScopedAgentRegistry({
      agentRegistry: this.agentRegistry,
      scope: this.codexAcpModelOverrideScope,
    });
    const sharedOptions = {
      ...options,
      sessionStore: this.sessionStore,
      agentRegistry: this.scopedAgentRegistry,
    };
    this.delegate = new BaseAcpxRuntime(sharedOptions, testOptions);
    this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options)
      ? new BaseAcpxRuntime(
          {
            ...sharedOptions,
            mcpServers: [],
          },
          testOptions,
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

    if (!codexModelOverride) {
      return delegate.ensureSession(input);
    }

    const normalizedInput = {
      ...input,
      ...(codexAcpSessionModelId(codexModelOverride)
        ? { model: codexAcpSessionModelId(codexModelOverride) }
        : {}),
    };
    return this.codexAcpModelOverrideScope.run(codexModelOverride, () =>
      delegate.ensureSession(normalizedInput),
    );
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
    if (isCodexAcpCommand(command)) {
      if (key === "timeout" || key === "timeout_seconds") {
        return;
      }
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
    const delegate = await this.resolveDelegateForHandle(input.handle);
    await delegate.cancel(input);
  }

  async prepareFreshSession(input: { sessionKey: string }): Promise<void> {
    this.sessionStore.markFresh(input.sessionKey);
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    await (
      await this.resolveDelegateForHandle(input.handle)
    ).close({
      handle: input.handle,
      reason: input.reason,
      discardPersistentState: input.discardPersistentState,
    });
    if (input.discardPersistentState) {
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
  isCodexAcpCommand,
  normalizeCodexAcpModelOverride,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
