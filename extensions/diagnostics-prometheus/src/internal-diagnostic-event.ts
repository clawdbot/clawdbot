import type { DiagnosticEventPayload } from "../api.js";

export type InternalDiagnosticEvent =
  | DiagnosticEventPayload
  | {
      seq: number;
      ts: number;
      type: "session.maintenance.pruned";
      pruned: number;
      retentionMs: number;
    };
