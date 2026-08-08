import type {
  GatewayNodeCompatEvidence,
  GatewayNodeCompatProducer,
} from "./gateway-node-compat-evidence.mjs";
import type { ArtifactBinding } from "./lib/actions-artifact-archive.mjs";

export const GATEWAY_NODE_COMPAT_RELEASE_SCHEMA: string;
export const GATEWAY_NODE_COMPAT_BASELINE_VERSION: "2026.5.7";
export const GATEWAY_NODE_COMPAT_BASELINE_TAG: "v2026.5.7";
export const GATEWAY_NODE_COMPAT_BASELINE_SOURCE_SHA: string;
export const GATEWAY_NODE_COMPAT_BASELINE_SHA256: string;
export const GATEWAY_NODE_COMPAT_BASELINE_NPM_INTEGRITY: string;
export const GATEWAY_NODE_COMPAT_RELEASE_CHECKS_WORKFLOW: string;
export const GATEWAY_NODE_COMPAT_EVIDENCE_WORKFLOW: string;
export const GATEWAY_NODE_COMPAT_PRODUCER_JOB: string;

export type GatewayNodeCompatFileSummary = {
  caseId: string;
  direction: GatewayNodeCompatEvidence["direction"];
  outcome: GatewayNodeCompatEvidence["result"]["outcome"];
  gatewayVersion: string;
  nodeVersion: string;
  gatewayProtocolVersion: number;
  gatewayAcceptedNodeMin: number;
  protocolClientAdvertisedMin: number;
  protocolClientAdvertisedMax: number;
  helloProtocol: number | null;
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type GatewayNodeCompatManifestEvidence = {
  architecture: "x64";
  artifact: {
    digest: string;
    id: number;
    name: string;
    producerJob: string;
    repository: string;
    runAttempt: number;
    runId: string;
    sizeBytes: number;
    workflowPath: string;
    workflowSha: string;
  };
  baseline: {
    npmIntegrity: string;
    sha256: string;
    sourceSha: string;
    tag: "v2026.5.7";
    version: "2026.5.7";
  };
  baselineVersion: "2026.5.7";
  files: GatewayNodeCompatFileSummary[];
  platform: "linux";
  producer: GatewayNodeCompatProducer;
  schema: string;
  targetSha: string;
};

export function validateGatewayNodeCompatEvidenceSet(
  files: Map<string, Uint8Array>,
  expected: {
    candidatePackageSha256: string;
    repository: string;
    runAttempt: number;
    runId: string | number;
    targetSha: string;
    workflowSha: string;
  },
): {
  baseline: GatewayNodeCompatManifestEvidence["baseline"];
  baselineVersion: "2026.5.7";
  files: GatewayNodeCompatFileSummary[];
  producer: GatewayNodeCompatProducer;
  targetSha: string;
};

export function selectGatewayNodeCompatArtifact(params: {
  artifacts: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  required: boolean;
  run: Record<string, unknown>;
}):
  | {
      artifact: Record<string, unknown>;
      job: Record<string, unknown>;
      runAttempt: number;
    }
  | undefined;

export function collectGatewayNodeCompatReleaseEvidence(
  params: {
    now?: () => number;
    onWarning?: (message: string) => void;
    repository: string;
    retryDeadlineMs?: number;
    retryDelayMs?: number;
    runId: string | number;
    sleep?: (delayMs: number) => Promise<void>;
    targetSha: string;
    token?: string;
    workflowSha: string;
  } & (
    | { candidatePackageSha256?: never; mode: "not-selected" }
    | { candidatePackageSha256: string; mode: "advisory" | "required" }
  ),
  client?: {
    getArtifacts(runId: string, repository: string): Promise<Array<Record<string, unknown>>>;
    getJobs(runId: string, repository: string): Promise<Array<Record<string, unknown>>>;
    getRun(runId: string, repository: string): Promise<Record<string, unknown>>;
    readArtifact(expected: ArtifactBinding): Promise<{ files: Map<string, Buffer> }>;
  },
): Promise<GatewayNodeCompatManifestEvidence | null>;

export function createGatewayNodeCompatReleaseEvidenceClient(token?: string): {
  getArtifacts(runId: string, repository: string): Promise<Array<Record<string, unknown>>>;
  getJobs(runId: string, repository: string): Promise<Array<Record<string, unknown>>>;
  getRun(runId: string, repository: string): Promise<Record<string, unknown>>;
  readArtifact(expected: ArtifactBinding): Promise<{ files: Map<string, Buffer> }>;
};

export function validateGatewayNodeCompatManifestEvidence(
  value: unknown,
): GatewayNodeCompatManifestEvidence;

export function renderGatewayNodeCompatSummary(value: unknown): string;
