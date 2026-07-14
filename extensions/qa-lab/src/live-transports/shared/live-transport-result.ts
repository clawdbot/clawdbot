// Qa Lab plugin module implements shared live-transport result shapes.
import type { QaEvidenceTiming } from "../../evidence-summary.js";

type LiveTransportRttMeasurement = {
  finalMatchedReplyRttMs: number;
  requestStartedAt: string;
  responseObservedAt: string;
  source: "request-to-observed-message";
};

export type LiveTransportCheckResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
  coverageIds?: readonly string[];
  timing?: QaEvidenceTiming;
  rttMs?: number;
  requestStartedAt?: string;
  responseObservedAt?: string;
  rttMeasurement?: LiveTransportRttMeasurement;
  sentMessageId?: number;
  responseMessageId?: number;
};
