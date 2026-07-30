#!/usr/bin/env node

export type FipsCheckStatus = "pass" | "fail" | "warn" | "skip";

export type FipsCheck = {
  id: string;
  status: FipsCheckStatus;
  required: boolean;
  detail: string;
  remediation?: string;
};

export type FipsProbe = {
  name: string;
  ok: boolean;
  error?: string;
};

export type FipsActivation = {
  enableFipsFlag: boolean;
  forceFipsFlag: boolean;
  opensslConfig: boolean;
  opensslModules: boolean;
};

export type FipsEvidence = {
  platform: string;
  arch: string;
  hostname: string;
  node: {
    version: string;
    openSslVersion: string;
    fipsEnabled: boolean;
  };
  activation: FipsActivation;
  kernelIndicator: string | null;
  openSslCli: {
    ok: boolean;
    version: string;
    error?: string;
  };
  crypto: {
    hashes: string[];
    ciphers: string[];
    curves: string[];
    primitiveProbes: FipsProbe[];
    tls13: FipsProbe;
    md4Available: boolean;
    ed25519: FipsProbe;
  };
};

export type FipsEvidenceOptions = {
  fsImpl?: {
    readFileSync(path: string, encoding: "utf8"): string;
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
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  platform?: string;
  arch?: string;
  hostname?: string;
  nodeVersion?: string;
  openSslVersion?: string;
};

export type FipsReport = {
  schemaVersion: number;
  kind: "openclaw-fips-runtime-report";
  generatedAt: string;
  ok: boolean;
  runtime: Record<string, string>;
  activation: FipsActivation;
  summary: Record<FipsCheckStatus, number>;
  checks: FipsCheck[];
  limitations: string[];
};

export function collectFipsEvidence(options?: FipsEvidenceOptions): FipsEvidence;
export function evaluateFipsChecks(evidence: FipsEvidence): FipsCheck[];
export function createFipsReport(evidence: FipsEvidence, now?: number): FipsReport;
export function formatFipsReport(report: FipsReport): string;
