#!/usr/bin/env node

export type RhelFipsCheckStatus = "pass" | "fail" | "warn" | "skip";

export type RhelFipsCheck = {
  id: string;
  status: RhelFipsCheckStatus;
  required: boolean;
  detail: string;
  remediation?: string;
};

export type RhelFipsProbe = {
  name: string;
  ok: boolean;
  error?: string;
};

export type RhelFipsEvidence = {
  platform: string;
  arch: string;
  hostname: string;
  osRelease: Record<string, string>;
  node: {
    version: string;
    openSslVersion: string;
    sharedOpenSsl: boolean;
    sqliteAvailable: boolean;
    sqliteError: string;
  };
  fips: {
    kernelIndicator: string | null;
    systemMarkerPresent: boolean;
    nodeEnabled: boolean;
  };
  openSslCli: {
    ok: boolean;
    version: string;
    error?: string;
  };
  crypto: {
    hashes: string[];
    ciphers: string[];
    curves: string[];
    primitiveProbes: RhelFipsProbe[];
    tls13: RhelFipsProbe;
    md4Available: boolean;
    ed25519: RhelFipsProbe;
  };
};

export type RhelFipsEvidenceOptions = {
  fsImpl?: {
    readFileSync(path: string, encoding: "utf8"): string;
    existsSync(path: string): boolean;
  };
  execFileSyncImpl?: (
    file: string,
    args: string[],
    options: {
      encoding: "utf8";
      stdio: ["ignore", "pipe", "pipe"];
      timeout: number;
    },
  ) => string;
  cryptoImpl?: typeof import("node:crypto");
  tlsImpl?: typeof import("node:tls");
  platform?: string;
  arch?: string;
  hostname?: string;
};

export type RhelFipsReport = {
  schemaVersion: number;
  profile: string;
  generatedAt: string;
  ok: boolean;
  runtime: Record<string, string>;
  summary: Record<RhelFipsCheckStatus, number>;
  checks: RhelFipsCheck[];
  limitations: string[];
};

export function collectRhelFipsEvidence(
  options?: RhelFipsEvidenceOptions,
): Promise<RhelFipsEvidence>;
export function evaluateRhelFipsChecks(evidence: RhelFipsEvidence): RhelFipsCheck[];
export function createRhelFipsReport(evidence: RhelFipsEvidence, now?: number): RhelFipsReport;
export function formatRhelFipsReport(report: RhelFipsReport): string;
