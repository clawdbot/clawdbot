declare module "acpx/runtime" {
  export const ACPX_BACKEND_ID: string;

  export type AcpRuntimeDoctorReport = import("../runtime-api.js").AcpRuntimeDoctorReport;
  export type AcpRuntimeEnsureInput = import("../runtime-api.js").AcpRuntimeEnsureInput;
  export type AcpRuntimeEvent = import("../runtime-api.js").AcpRuntimeEvent;
  export type AcpRuntimeHandle = import("../runtime-api.js").AcpRuntimeHandle;
  export type AcpRuntimeCapabilities = import("../runtime-api.js").AcpRuntimeCapabilities;
  export type AcpRuntimeStatus = import("../runtime-api.js").AcpRuntimeStatus;
  export type AcpRuntimeTurnInput = import("../runtime-api.js").AcpRuntimeTurnInput;

  export type AcpAgentRegistry = {
    resolve(agent: string): string | undefined;
    list(): string[];
  };

  export type AcpSessionRecord = Record<string, unknown>;

  export type AcpSessionStore = {
    load(sessionId: string): Promise<AcpSessionRecord | undefined>;
    save(record: AcpSessionRecord): Promise<void>;
  };

  export type AcpRuntimeOptions = {
    cwd: string;
    sessionStore: AcpSessionStore;
    agentRegistry: AcpAgentRegistry;
    mcpServers?: unknown;
    permissionMode?: unknown;
    nonInteractivePermissions?: unknown;
    timeoutMs?: number;
  };

  export class AcpxRuntime {
    constructor(options: AcpRuntimeOptions, testOptions?: unknown);
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<AcpRuntimeDoctorReport>;
    ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
    runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
    getCapabilities(input?: {
      handle?: AcpRuntimeHandle;
    }): AcpRuntimeCapabilities | Promise<AcpRuntimeCapabilities>;
    getStatus(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
    setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
    setConfigOption(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;
    cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
    close(input: {
      handle: AcpRuntimeHandle;
      reason?: string;
      discardPersistentState?: boolean;
    }): Promise<void>;
  }

  export function createAcpRuntime(...args: unknown[]): AcpxRuntime;
  export function createAgentRegistry(params: { overrides?: unknown }): AcpAgentRegistry;
  export function createFileSessionStore(params: { stateDir: string }): AcpSessionStore;
  export function decodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
  export function encodeAcpxRuntimeHandleState(...args: unknown[]): unknown;
}
