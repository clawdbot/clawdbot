import type { OpenClawConfig } from "../config/config.js";
import "./runtime.js";
import type { CommitmentExtractionBatchResult, CommitmentExtractionItem } from "./types.js";

type TimerHandle = ReturnType<typeof setTimeout>;

type CommitmentExtractionRuntime = {
  extractBatch?: (params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
  }) => Promise<CommitmentExtractionBatchResult>;
  resolveDefaultModel?: (params: { cfg: OpenClawConfig; agentId?: string }) => {
    provider: string;
    model: string;
  };
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  forceInTests?: boolean;
};

type CommitmentRuntimeTestApi = {
  configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void;
  drainCommitmentExtractionQueue(): Promise<number>;
  resetCommitmentExtractionRuntimeForTests(): void;
};

function getTestApi(): CommitmentRuntimeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commitmentRuntimeTestApi")
  ];
  if (!api) {
    throw new Error("commitment runtime test API is unavailable");
  }
  return api as CommitmentRuntimeTestApi;
}

export function configureCommitmentExtractionRuntime(next: CommitmentExtractionRuntime): void {
  getTestApi().configureCommitmentExtractionRuntime(next);
}

export async function drainCommitmentExtractionQueue(): Promise<number> {
  return await getTestApi().drainCommitmentExtractionQueue();
}

export function resetCommitmentExtractionRuntimeForTests(): void {
  getTestApi().resetCommitmentExtractionRuntimeForTests();
}
