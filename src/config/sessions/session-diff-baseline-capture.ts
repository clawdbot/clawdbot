import { randomUUID } from "node:crypto";

export type SessionDiffBaselineCapture = {
  version: 1;
  captureId: string;
  status: "pending" | "unavailable";
};

export function createSessionDiffBaselineCaptureClaim(): SessionDiffBaselineCapture {
  return { version: 1, captureId: randomUUID(), status: "pending" };
}
