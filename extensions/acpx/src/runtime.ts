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
import type { AcpRuntime } from "../runtime-api.js";

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
  private readonly delegate: BaseAcpxRuntime;
  private readonly bridgeSafeDelegate: BaseAcpxRuntime;
  private readonly probeDelegate: BaseAcpxRuntime;

  constructor(
    options: AcpRuntimeOptions,
    testOptions?: ConstructorParameters<typeof BaseAcpxRuntime>[1],
  ) {
    this.sessionStore = createResetAwareSessionStore(options.sessionStore);
    this.agentRegistry = options.agentRegistry;
    const sharedOptions = {
      ...options,
      sessionStore: this.sessionStore,
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

  isHealthy(): boolean {
    return this.probeDelegate.isHealthy();
  }

  probeAvailability(): Promise<void> {
    return this.probeDelegate.probeAvailability();
  }

  doctor(): Promise<AcpRuntimeDoctorReport> {
    return this.probeDelegate.doctor();
  }

  ensureSession(input: Parameters<AcpRuntime["ensureSession"]>[0]): Promise<AcpRuntimeHandle> {
    return this.resolveDelegateForAgent(input.agent).ensureSession(input);
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

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
