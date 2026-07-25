import type { ClawManifest } from "@openclaw/claw-spec";

export const OUTCOME_SCHEMA_VERSION = "claw.cliOutcome.v0" as const;
export const INCUBATION_STABILITY = "private-incubation" as const;

export type CliDiagnostic = {
  code: string;
  phase: "arguments" | "source" | "package" | "adapter";
  message: string;
  path?: string;
};

export type LocalClawPackage = {
  source: {
    kind: "local-package";
    path: string;
    packageName: string;
    packageVersion: string;
    integrity: string;
    byteLength: number;
    fileCount: number;
  };
  manifest: ClawManifest;
  manifestPath: string;
  payload: Array<{ path: string; bytes: Buffer }>;
  summary: {
    agent: ClawManifest["agent"];
    bootstrapFiles: string[];
    workspaceFileCount: number;
    skillCount: number;
    pluginCount: number;
    mcpServerCount: number;
    cronJobCount: number;
    hasPortablePrompt: boolean;
    openClawProfilePath?: string;
  };
};

type OutcomeBase = {
  schemaVersion: typeof OUTCOME_SCHEMA_VERSION;
  stability: typeof INCUBATION_STABILITY;
  operation: "inspect" | "preview";
};

export type SuccessOutcome = OutcomeBase & {
  ok: true;
  package: LocalClawPackage["source"];
  claw: LocalClawPackage["summary"];
  harness?: { id: string; outcome: unknown };
  diagnostics: [];
};

export type FailureOutcome = OutcomeBase & {
  ok: false;
  harness?: { id: string; outcome: unknown };
  diagnostics: CliDiagnostic[];
};

export type CliOutcome = SuccessOutcome | FailureOutcome;
