import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  isDangerousHostInheritedEnvVarName,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
} from "./host-env-security.js";

type HostEnvReportedBaseline = {
  source: string;
  generatedAt: string;
  reportedDangerousEverywhereKeys: string[];
  reportedDangerousOverrideOnlyKeys: string[];
  expectedTotalReportedEntries: number;
};

const INHERITED_ALLOWLIST_RATIONALE: Record<string, string> = {
  ALL_PROXY: "Trusted inherited global proxy route from operator runtime.",
  AWS_CONFIG_FILE: "Trusted inherited AWS CLI/SDK config path selected by operator.",
  AWS_SHARED_CREDENTIALS_FILE:
    "Trusted inherited AWS shared credentials path selected by operator.",
  AWS_WEB_IDENTITY_TOKEN_FILE: "Trusted inherited AWS web identity token path.",
  AZURE_AUTH_LOCATION: "Trusted inherited Azure auth location selected by operator.",
  CURL_CA_BUNDLE: "Trusted inherited CA bundle path for TLS validation.",
  DOCKER_CERT_PATH: "Trusted inherited Docker client certificate location.",
  DOCKER_CONTEXT: "Trusted inherited Docker context selector from operator runtime.",
  DOCKER_HOST: "Trusted inherited Docker endpoint selected by operator.",
  DOCKER_TLS_VERIFY: "Trusted inherited Docker TLS verification mode.",
  GIT_PAGER: "Trusted inherited interactive pager preference.",
  GOOGLE_APPLICATION_CREDENTIALS:
    "Trusted inherited Google application credentials path selected by operator.",
  GRADLE_USER_HOME: "Trusted inherited tool cache directory location.",
  HISTFILE: "Trusted inherited shell history path.",
  HOME: "Trusted inherited process home-directory context.",
  HTTPS_PROXY: "Trusted inherited HTTPS proxy route from operator runtime.",
  HTTP_PROXY: "Trusted inherited HTTP proxy route from operator runtime.",
  KUBECONFIG: "Trusted inherited Kubernetes config path selected by operator.",
  MANPAGER: "Trusted inherited manual-page pager preference.",
  NODE_EXTRA_CA_CERTS: "Trusted inherited extra Node CA trust roots.",
  NODE_TLS_REJECT_UNAUTHORIZED: "Trusted inherited Node TLS mode from runtime policy.",
  NO_PROXY: "Trusted inherited proxy bypass list from operator runtime.",
  PAGER: "Trusted inherited default pager preference.",
  REQUESTS_CA_BUNDLE: "Trusted inherited Python requests CA bundle path.",
  SSH_AUTH_SOCK: "Trusted inherited SSH agent socket from operator runtime.",
  SSL_CERT_DIR: "Trusted inherited OpenSSL certificate directory path.",
  SSL_CERT_FILE: "Trusted inherited OpenSSL certificate file path.",
  SYSTEMROOT: "Trusted inherited Windows system root selected by the host OS.",
  WINDIR: "Trusted inherited Windows directory selected by the host OS.",
  ZDOTDIR: "Trusted inherited shell startup directory boundary.",
};

function readBaselineAndPolicy(): {
  baseline: HostEnvReportedBaseline;
  allowedInheritedOverrideOnlyKeys: string[];
} {
  const repoRoot = process.cwd();
  const baselinePath = path.join(repoRoot, "src/infra/host-env-security.reported-baseline.json");
  const policyPath = path.join(repoRoot, "src/infra/host-env-security-policy.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as HostEnvReportedBaseline;
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
    allowedInheritedOverrideOnlyKeys?: string[];
  };
  return {
    baseline,
    allowedInheritedOverrideOnlyKeys: (policy.allowedInheritedOverrideOnlyKeys ?? []).map((key) =>
      key.toUpperCase(),
    ),
  };
}

function sortUniqueUpper(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.toUpperCase()))).toSorted((a, b) =>
    a.localeCompare(b),
  );
}

describe("host env reported baseline coverage", () => {
  it("keeps the fixed reported dangerous env baseline fully covered by inherited + override sanitization", () => {
    const { baseline, allowedInheritedOverrideOnlyKeys } = readBaselineAndPolicy();

    expect(
      baseline.reportedDangerousEverywhereKeys.length +
        baseline.reportedDangerousOverrideOnlyKeys.length,
    ).toBe(baseline.expectedTotalReportedEntries);
    expect(baseline.expectedTotalReportedEntries).toBe(234);
    expect(sortUniqueUpper(baseline.reportedDangerousEverywhereKeys)).toEqual(
      baseline.reportedDangerousEverywhereKeys,
    );
    expect(sortUniqueUpper(baseline.reportedDangerousOverrideOnlyKeys)).toEqual(
      baseline.reportedDangerousOverrideOnlyKeys,
    );

    const inheritedInput: Record<string, string> = {
      PATH: "/usr/bin:/bin",
    };
    for (const key of baseline.reportedDangerousEverywhereKeys) {
      inheritedInput[key] = `${key.toLowerCase()}-from-inherited`;
    }
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      inheritedInput[key] = `${key.toLowerCase()}-from-inherited`;
    }
    const inheritedSanitized = sanitizeHostExecEnv({ baseEnv: inheritedInput });

    for (const key of baseline.reportedDangerousEverywhereKeys) {
      expect(isDangerousHostEnvVarName(key)).toBe(true);
      expect(isDangerousHostInheritedEnvVarName(key)).toBe(true);
      expect(inheritedSanitized[key]).toBeUndefined();
    }

    const inheritedAllowlist = new Set(allowedInheritedOverrideOnlyKeys);
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      expect(isDangerousHostEnvOverrideVarName(key)).toBe(true);
      if (inheritedAllowlist.has(key)) {
        expect(isDangerousHostInheritedEnvVarName(key)).toBe(false);
        expect(inheritedSanitized[key]).toBe(`${key.toLowerCase()}-from-inherited`);
      } else {
        expect(isDangerousHostInheritedEnvVarName(key)).toBe(true);
        expect(inheritedSanitized[key]).toBeUndefined();
      }
    }

    const overrideInput: Record<string, string> = {};
    for (const key of baseline.reportedDangerousEverywhereKeys) {
      overrideInput[key] = `${key.toLowerCase()}-from-override`;
    }
    for (const key of baseline.reportedDangerousOverrideOnlyKeys) {
      overrideInput[key] = `${key.toLowerCase()}-from-override`;
    }

    const overrideResult = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: { PATH: "/usr/bin:/bin" },
      overrides: overrideInput,
    });
    const expectedRejectedOverrideKeys = sortUniqueUpper([
      ...baseline.reportedDangerousEverywhereKeys,
      ...baseline.reportedDangerousOverrideOnlyKeys,
    ]);
    expect(overrideResult.rejectedOverrideBlockedKeys).toEqual(expectedRejectedOverrideKeys);
    expect(overrideResult.rejectedOverrideInvalidKeys).toStrictEqual([]);

    for (const key of expectedRejectedOverrideKeys) {
      expect(overrideResult.env[key]).toBeUndefined();
    }
  });

  it("documents and enforces rationale for every inherited allowlist exception", () => {
    const { allowedInheritedOverrideOnlyKeys } = readBaselineAndPolicy();
    const expectedAllowlistKeys = Object.keys(INHERITED_ALLOWLIST_RATIONALE).toSorted((a, b) =>
      a.localeCompare(b),
    );
    expect(allowedInheritedOverrideOnlyKeys.toSorted((a, b) => a.localeCompare(b))).toEqual(
      expectedAllowlistKeys,
    );

    for (const key of expectedAllowlistKeys) {
      expect(INHERITED_ALLOWLIST_RATIONALE[key].trim().length).toBeGreaterThan(0);
      expect(isDangerousHostInheritedEnvVarName(key)).toBe(false);
      expect([isDangerousHostEnvVarName(key), isDangerousHostEnvOverrideVarName(key)]).toContain(
        true,
      );

      const inheritedSanitized = sanitizeHostExecEnv({
        baseEnv: {
          PATH: "/usr/bin:/bin",
          [key]: `${key.toLowerCase()}-trusted-inherited`,
        },
      });
      expect(inheritedSanitized[key]).toBe(`${key.toLowerCase()}-trusted-inherited`);

      const overrideResult = sanitizeHostExecEnvWithDiagnostics({
        baseEnv: { PATH: "/usr/bin:/bin" },
        overrides: {
          [key]: `${key.toLowerCase()}-untrusted-override`,
        },
      });
      expect(overrideResult.rejectedOverrideBlockedKeys).toEqual([key]);
      expect(overrideResult.rejectedOverrideInvalidKeys).toStrictEqual([]);
      expect(overrideResult.env[key]).toBeUndefined();
    }
  });
});
