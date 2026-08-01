import type { OpenClawConfig } from "../config/config.js";
import "./extraction.js";
import type {
  CommitmentCandidate,
  CommitmentExtractionBatchResult,
  CommitmentExtractionItem,
} from "./types.js";

type ValidatedCommitmentCandidate = {
  item: CommitmentExtractionItem;
  candidate: CommitmentCandidate;
  earliestMs: number;
  latestMs: number;
  timezone: string;
};

type CommitmentExtractionTestApi = {
  validateCommitmentCandidates(params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
    result: CommitmentExtractionBatchResult;
    nowMs?: number;
  }): ValidatedCommitmentCandidate[];
};

function getTestApi(): CommitmentExtractionTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.commitmentExtractionTestApi")
  ];
  if (!api) {
    throw new Error("commitment extraction test API is unavailable");
  }
  return api as CommitmentExtractionTestApi;
}

export function validateCommitmentCandidates(
  params: Parameters<CommitmentExtractionTestApi["validateCommitmentCandidates"]>[0],
): ValidatedCommitmentCandidate[] {
  return getTestApi().validateCommitmentCandidates(params);
}
