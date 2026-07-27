import { Value } from "typebox/value";
import { CanonicalReadinessResultSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { callGateway } from "../gateway/call.js";
import {
  formatHostingProfileIds,
  getStandardHostingProfile,
  HOSTING_PROFILE_IDS,
  HOSTING_PROFILE_CONTRACT_VERSION,
  listStandardHostingProfiles,
  parseHostingProfileId,
  type HostingProfileDescriptor,
} from "../hosting/profiles.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type HostingProfilesCommandOptions = {
  json?: boolean;
};

type HostingProfileValidationOptions = HostingProfilesCommandOptions & {
  timeoutMs?: number;
};

type HostingProfileValidationFinding = {
  reason:
    | "GatewayReadinessUnavailable"
    | "ReadinessResultInvalid"
    | "ReadinessContractMismatch"
    | "HostingProfileNotSelected"
    | "HostingProfileMismatch"
    | "HostingProfileContractMismatch"
    | "HostingProfileUnknown"
    | "HostingProfileConditionMissing"
    | "HostingProfileConditionDuplicate"
    | "HostingProfileConditionNotRequired";
  message: string;
};

type HostingProfileValidationResult = {
  contractVersion: 1;
  conformant: boolean;
  ready: boolean;
  expectedProfile?: string;
  activeProfile?: string;
  findings: HostingProfileValidationFinding[];
  readiness?: unknown;
};

const HOSTING_PROFILE_VALIDATION_CONTRACT_VERSION = 1 as const;

function formatReportedValue(value: unknown): string {
  if (value === undefined) {
    return "none";
  }
  try {
    return JSON.stringify(value) ?? "none";
  } catch {
    return "unserializable value";
  }
}

function formatProfileList(profiles: HostingProfileDescriptor[]): string {
  return renderTable({
    width: getTerminalTableWidth(),
    border: "none",
    columns: [
      { key: "profile", header: "PROFILE", minWidth: 14 },
      { key: "posture", header: "POSTURE", flex: true, minWidth: 28 },
      { key: "conditions", header: "CONDITIONS", minWidth: 10 },
      { key: "required", header: "REQUIRED", minWidth: 8 },
      { key: "advisory", header: "ADVISORY", minWidth: 8 },
    ],
    rows: profiles.map((profile) => ({
      profile: profile.id,
      posture: profile.description,
      conditions: String(profile.profileConditions.length),
      required: String(profile.requiredCriteria.length),
      advisory: String(profile.advisoryCriteria.length),
    })),
  });
}

function formatProfile(profile: HostingProfileDescriptor): string {
  const section = (label: string, values: readonly string[]) => [
    `${label}:`,
    ...values.map((value) => `- ${value}`),
  ];
  return [
    `Profile: ${profile.id}`,
    `Contract version: ${HOSTING_PROFILE_CONTRACT_VERSION}`,
    `Posture: ${profile.description}`,
    "",
    ...section("Profile conditions", profile.profileConditions),
    "",
    ...section("Required criteria", profile.requiredCriteria),
    "",
    ...section("Advisory criteria", profile.advisoryCriteria),
  ].join("\n");
}

export function hostingProfilesListCommand(
  options: HostingProfilesCommandOptions,
  runtime: RuntimeEnv,
): void {
  const profiles = listStandardHostingProfiles();
  if (options.json) {
    writeRuntimeJson(runtime, {
      contractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
      profiles,
    });
    return;
  }
  runtime.log(formatProfileList(profiles));
}

export function hostingProfilesInspectCommand(
  id: string,
  options: HostingProfilesCommandOptions,
  runtime: RuntimeEnv,
): void {
  const profileId = parseHostingProfileId(id);
  if (!profileId) {
    runtime.error(
      `Unknown hosting profile ${JSON.stringify(id)}. Use ${formatHostingProfileIds()}.`,
    );
    runtime.exit(1);
    return;
  }
  const profile = getStandardHostingProfile(profileId);
  if (options.json) {
    writeRuntimeJson(runtime, {
      contractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
      profile,
    });
    return;
  }
  runtime.log(formatProfile(profile));
}

function evaluateHostingProfileConformance(
  readiness: unknown,
  expectedProfile?: string,
): HostingProfileValidationResult {
  const findings: HostingProfileValidationFinding[] = [];
  if (typeof readiness !== "object" || readiness === null || Array.isArray(readiness)) {
    return {
      contractVersion: HOSTING_PROFILE_VALIDATION_CONTRACT_VERSION,
      conformant: false,
      ready: false,
      ...(expectedProfile ? { expectedProfile } : {}),
      findings: [
        {
          reason: "ReadinessResultInvalid",
          message: "The Gateway returned an invalid canonical readiness result.",
        },
      ],
      readiness,
    };
  }

  const snapshot = readiness as Record<string, unknown>;
  const activeProfile = typeof snapshot.profile === "string" ? snapshot.profile : undefined;
  const profile = HOSTING_PROFILE_IDS.find((id) => id === activeProfile);
  const canonicalResult = {
    contractVersion: snapshot.contractVersion,
    evaluatedAtMs: snapshot.evaluatedAtMs,
    identity: snapshot.identity,
    ready: snapshot.ready,
    conditions: snapshot.conditions,
    failures: snapshot.failures,
    advisories: snapshot.advisories,
  };
  const canonicalResultValid = Value.Check(CanonicalReadinessResultSchema, canonicalResult);
  if (snapshot.contractVersion !== 1) {
    findings.push({
      reason: "ReadinessContractMismatch",
      message: `Expected readiness contract version 1, but the running Gateway reported ${formatReportedValue(snapshot.contractVersion)}.`,
    });
  }
  if (!canonicalResultValid) {
    findings.push({
      reason: "ReadinessResultInvalid",
      message: "The Gateway returned an invalid canonical readiness result.",
    });
  }
  const conditions = canonicalResultValid
    ? (snapshot.conditions as Array<Record<string, unknown>>)
    : [];

  if (!activeProfile) {
    findings.push({
      reason: "HostingProfileNotSelected",
      message: "The running Gateway has no active Standard Hosting Profile.",
    });
  } else if (!profile) {
    findings.push({
      reason: "HostingProfileUnknown",
      message: `The running Gateway reported unknown hosting profile ${JSON.stringify(activeProfile)}.`,
    });
  }
  if (expectedProfile && activeProfile !== expectedProfile) {
    findings.push({
      reason: "HostingProfileMismatch",
      message: `Expected hosting profile ${expectedProfile}, but the running Gateway reported ${activeProfile ?? "no profile"}.`,
    });
  }
  if (activeProfile && snapshot.profileContractVersion !== HOSTING_PROFILE_CONTRACT_VERSION) {
    findings.push({
      reason: "HostingProfileContractMismatch",
      message: `Expected hosting profile contract version ${HOSTING_PROFILE_CONTRACT_VERSION}, but the running Gateway reported ${formatReportedValue(snapshot.profileContractVersion)}.`,
    });
  }

  if (profile) {
    const descriptor = getStandardHostingProfile(profile);
    for (const type of descriptor.profileConditions) {
      const matches = conditions.filter((condition) => condition.type === type);
      if (matches.length === 0) {
        findings.push({
          reason: "HostingProfileConditionMissing",
          message: `The canonical readiness result is missing profile condition ${type}.`,
        });
        continue;
      }
      if (matches.length > 1) {
        findings.push({
          reason: "HostingProfileConditionDuplicate",
          message: `The canonical readiness result contains profile condition ${type} more than once.`,
        });
      }
      if (matches.some((condition) => condition.requirement !== "required")) {
        findings.push({
          reason: "HostingProfileConditionNotRequired",
          message: `Profile condition ${type} is not consistently required.`,
        });
      }
    }
  }

  return {
    contractVersion: HOSTING_PROFILE_VALIDATION_CONTRACT_VERSION,
    conformant: findings.length === 0,
    ready: canonicalResultValid && snapshot.ready === true,
    ...(expectedProfile ? { expectedProfile } : {}),
    ...(activeProfile ? { activeProfile } : {}),
    findings,
    readiness,
  };
}

function formatProfileValidation(result: HostingProfileValidationResult): string {
  const lines = [
    `Profile: ${result.activeProfile ?? "none"}`,
    ...(result.expectedProfile ? [`Expected profile: ${result.expectedProfile}`] : []),
    `Conformant: ${result.conformant ? "yes" : "no"}`,
    `Ready: ${result.ready ? "yes" : "no"}`,
  ];
  if (result.findings.length > 0) {
    lines.push("", "Conformance findings:");
    for (const finding of result.findings) {
      lines.push(`- ${finding.reason}: ${finding.message}`);
    }
  }
  const failures =
    typeof result.readiness === "object" &&
    result.readiness !== null &&
    !Array.isArray(result.readiness) &&
    Array.isArray((result.readiness as Record<string, unknown>).failures)
      ? ((result.readiness as Record<string, unknown>).failures as unknown[]).filter(
          (failure): failure is string => typeof failure === "string",
        )
      : [];
  if (failures.length > 0) {
    lines.push("", "Readiness failures:", ...failures.map((failure) => `- ${failure}`));
  }
  return lines.join("\n");
}

export async function hostingProfilesValidateCommand(
  id: string | undefined,
  options: HostingProfileValidationOptions,
  runtime: RuntimeEnv,
  dependencies: {
    callReady?: (params: { timeoutMs?: number }) => Promise<unknown>;
  } = {},
): Promise<void> {
  const parsedExpectedProfile = id === undefined ? undefined : parseHostingProfileId(id);
  if (id !== undefined && !parsedExpectedProfile) {
    runtime.error(
      `Unknown hosting profile ${JSON.stringify(id)}. Use ${formatHostingProfileIds()}.`,
    );
    runtime.exit(1);
    return;
  }
  const expectedProfile = parsedExpectedProfile ?? undefined;

  const callReady =
    dependencies.callReady ??
    (async ({ timeoutMs }) =>
      await callGateway<unknown>({
        method: "ready",
        params: {},
        timeoutMs,
      }));

  let result: HostingProfileValidationResult;
  try {
    const readiness = await callReady({ timeoutMs: options.timeoutMs });
    result = evaluateHostingProfileConformance(readiness, expectedProfile);
  } catch (error) {
    result = {
      contractVersion: HOSTING_PROFILE_VALIDATION_CONTRACT_VERSION,
      conformant: false,
      ready: false,
      ...(expectedProfile ? { expectedProfile } : {}),
      findings: [
        {
          reason: "GatewayReadinessUnavailable",
          message: formatErrorMessage(error),
        },
      ],
    };
  }

  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatProfileValidation(result));
  }
  if (!result.conformant || !result.ready) {
    runtime.exit(1);
  }
}
