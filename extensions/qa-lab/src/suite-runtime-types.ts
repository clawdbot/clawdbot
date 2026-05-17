import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaProviderMode } from "./model-selection.js";
import type { QaTransportActionName, QaTransportAdapter } from "./qa-transport.js";

type QaRuntimeGatewayClient = {
  baseUrl: string;
  tempRoot: string;
  workspaceDir: string;
  runtimeEnv: NodeJS.ProcessEnv;
  getProcessCpuMs?: () => number | null;
  getProcessRssBytes?: () => number | null;
  logs?: () => string;
  restartAfterStateMutation?: (
    mutateState: (context: {
      configPath: string;
      runtimeEnv: NodeJS.ProcessEnv;
      stateDir: string;
      tempRoot: string;
    }) => Promise<void>,
  ) => Promise<void>;
  call: (
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
};

type QaRuntimeTransport = QaTransportAdapter;

export type QaSuiteRuntimeEnv = {
  gateway: QaRuntimeGatewayClient;
  transport: QaRuntimeTransport;
  repoRoot: string;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  mock: {
    baseUrl: string;
  } | null;
  cfg: OpenClawConfig;
};

export type QaSkillStatusEntry = {
  name?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
};

export type QaConfigSnapshot = {
  hash?: string;
  config?: Record<string, unknown>;
};

export type QaDreamingStatus = {
  enabled?: boolean;
  shortTermCount?: number;
  promotedTotal?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  phases?: {
    deep?: {
      managedCronPresent?: boolean;
      nextRunAtMs?: number;
    };
  };
};

export type QaRawSessionStoreEntry = {
  sessionId?: string;
  sessionFile?: string;
  status?: string;
  spawnedBy?: string;
  label?: string;
  abortedLastRun?: boolean;
  updatedAt?: number;
};

export type QaRuntimeActionHandlerEnv = Pick<QaSuiteRuntimeEnv, "cfg" | "transport">;
export type { QaTransportActionName };
