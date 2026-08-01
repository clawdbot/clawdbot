export function shouldPrintHelp(argv: string[]): boolean;
export function validateCliArgs(argv: string[]): void;
export function readPositiveInt(raw: string | undefined, fallback: number, label?: string): number;
export function readPositiveTimerMs(
  raw: string | undefined,
  fallback: number,
  label?: string,
): number;
export function resolveKitchenSinkRpcConfig(env?: NodeJS.ProcessEnv): {
  commandMaxRssMiB: number;
  commandTimeoutMs: number;
  fetchBodyMaxBytes: number;
  fetchTimeoutMs: number;
  installTimeoutMs: number;
  maxRssMiB: number;
  outputCaptureChars: number;
  readyTimeoutMs: number;
  rpcTimeoutMs: number;
};
export function resolveKitchenSinkRpcPort(
  env?: NodeJS.ProcessEnv,
  options?: { findAvailablePort?: () => Promise<number> },
): Promise<number>;
export function makeEnv(): {
  root: string;
  env: {
    HOME: string;
    USERPROFILE: string;
    OPENCLAW_HOME: string;
    OPENCLAW_STATE_DIR: string;
    OPENCLAW_CONFIG_PATH: string;
    OPENCLAW_NO_ONBOARD: string;
    OPENCLAW_SKIP_PROVIDERS: string;
    OPENCLAW_KITCHEN_SINK_PERSONALITY: string;
  };
};
export function cleanupKitchenSinkEnv(
  root: string,
  options?: {
    attempts?: number;
    delayMs?: number;
    throwOnFailure?: boolean;
    warn?: boolean;
  },
): Promise<boolean>;
export function appendBoundedOutput(
  buffer: { text: string; truncatedChars: number },
  chunk: string | Uint8Array,
  maxChars?: number,
): {
  text: string;
  truncatedChars: number;
};
export function runCommand(
  command: string,
  args: string[],
  options?: Record<string, unknown>,
): Promise<{
  stderr: string;
  stdout: string;
  stderrTruncatedChars: number;
  stdoutTruncatedChars: number;
}>;
export function signalProcessGroup(
  child: { pid?: number; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals,
  {
    platform,
    runTaskkill,
    useProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((
          command: string,
          args: string[],
          options: { stdio: "ignore" },
        ) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  },
): void;
export function parseJsonOutput(stdout: string): Record<string, unknown>;
export function parseGatewayCliRequestFailure(error: unknown):
  | (Error & {
      retryAfterMs?: number;
      retryable: boolean;
      details?: Record<string, unknown>;
      name: string;
      gatewayCode: string;
    })
  | null;
export function unwrapRpcPayload(raw: unknown): Record<string, unknown>;
export function createRpcCliRunOptions(
  method: string,
  options?: { env?: NodeJS.ProcessEnv; commandResourceOptions?: Record<string, unknown> },
): Record<string, unknown> & { resourceLabel: string; timeoutMs: number };
export function findDistCallGatewayModuleFiles(cwd?: string): string[];
export function usesBuiltOpenClawEntry(
  runner: unknown,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): boolean;
export function fetchJson(
  url: unknown,
  options?: Record<string, unknown>,
): Promise<{
  ok: unknown;
  status: unknown;
  body: unknown;
}>;
export function readBoundedResponseText(
  response: unknown,
  byteLimit: number,
  timeoutPromise?: Promise<never>,
): Promise<string>;
export function stopGateway(child: unknown, options?: Record<string, unknown>): Promise<void>;
export function hasChildExited(child: unknown): boolean;
export function signalGateway(
  child: unknown,
  signal: unknown,
  killProcess?: typeof defaultKillProcess,
  options?: Record<string, unknown>,
): boolean;
export function createGatewayReadyLogScanner(logPath: unknown, marker?: string): () => boolean;
export function waitForGatewayReady(
  child: unknown,
  port: unknown,
  logPath: unknown,
  options?: Record<string, unknown>,
): Promise<void>;
export function extractPluginCommandNames(payload: unknown): unknown[];
export function assertExpectedKitchenSinkToolEntries(
  entries: unknown,
  label: unknown,
  {
    requirePluginProvenance,
  }?: {
    requirePluginProvenance?: boolean | undefined;
  },
): unknown;
export function assertChannelAccountRunning(payload: unknown): unknown;
export function extractTtsProviderIds(payload: unknown, surface: unknown): unknown[];
export function assertTtsProviderCoverage(payload: unknown, surface: unknown): void;
export function assertKitchenSinkSearchInvokeResult(payload: unknown): void;
export function assertKitchenSinkTextInvokeResult(payload: unknown): void;
export function assertKitchenSinkImageJobInvokeResult(payload: unknown): void;
export function listKitchenSinkToolInvokeNames(): string[];
export function listKitchenSinkReadOnlyRpcProbeNames(): string[];
export function listKitchenSinkAuthorizationRpcProbeNames(): string[];
export function assertOperatorRpcDenied(probe: unknown, call: unknown): Promise<void>;
export function assertCreatedKitchenSinkSession(payload: unknown, expectedKey?: string): unknown;
export function assertKitchenSinkUiDescriptors(
  payload: unknown,
  options?: Record<string, unknown>,
): unknown;
export function assertDiagnosticStabilityClean(payload: unknown): void;
export function assertGatewayHealthPayload(payload: unknown): void;
export function assertGatewayStatusPayload(payload: unknown): void;
export function sampleProcess(
  pid: unknown,
  options?: Record<string, unknown>,
): Promise<{
  aggregateRssMiB: number;
  rssMiB: number;
  cpuPercent: unknown;
  processId: unknown;
} | null>;
export function summarizeProcessSamples(samples: unknown): unknown;
export function sampleWindowsProcessByPort(
  port: unknown,
  options?: Record<string, unknown>,
): Promise<
  | {
      rssMiB: number;
      aggregateRssMiB: number;
      cpuPercent: null;
      cpuSeconds: number | null;
      processId: number;
    }
  | {
      rssMiB: number;
      cpuPercent: null;
      cpuSeconds: null;
      processId: number;
    }
  | null
>;
export function assertResourceCeiling(sample: unknown): void;
export function assertCommandResourceCeiling(sample: unknown): void;
export function findErrorLogFindings(logPath: string): Array<{ line: string; lineNumber: number }>;
export function tailFile(file: string, maxBytes?: number): string;
export function main(): Promise<void>;
export const MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS: 2147000000;
declare function defaultKillProcess(pid: unknown, signal: unknown): true;
