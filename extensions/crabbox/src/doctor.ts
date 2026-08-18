import { getHealthCheck, type HealthCheck, type HealthFinding } from "openclaw/plugin-sdk/health";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import { CRABBOX_WORKER_PROVIDER_ID, findCrabboxBinary } from "./crabbox-worker-profile.js";

export const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";

type CrabboxDoctorRegistrationHost = {
  readonly openclawRoot: string;
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

function finding(params: {
  profileId: string;
  message: string;
  fixHint: string;
  binary?: string;
  severity?: "info" | "warning";
}): HealthFinding {
  return {
    checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
    severity: params.severity ?? "warning",
    source: "crabbox",
    message: `Cloud worker profile "${params.profileId}" ${params.message}`,
    ...(params.binary ? { path: params.binary } : {}),
    ocPath: `cloudWorkers.profiles.${params.profileId}.settings.binary`,
    target: params.profileId,
    requirement: "an executable Crabbox 0.41.1 or newer binary",
    fixHint: params.fixHint,
  };
}

function repairHint(profileId: string, explicitBinary?: string): string {
  const configPath = `cloudWorkers.profiles.${profileId}.settings.binary`;
  return explicitBinary
    ? `Install Crabbox 0.41.1 or newer at ${explicitBinary}, or set ${configPath} to an executable absolute path, then rerun \`openclaw doctor --json\`.`
    : `Install Crabbox 0.41.1 or newer on the Gateway user's PATH, or set ${configPath} to an executable absolute path, then rerun \`openclaw doctor --json\`.`;
}

function createCrabboxCloudWorkerProfileCheck(openclawRoot: string): HealthCheck {
  return {
    id: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
    kind: "plugin",
    description: "Verify configured Crabbox cloud worker binaries before dispatch.",
    source: "crabbox",
    async detect(ctx) {
      const profiles = Object.entries(ctx.cfg.cloudWorkers?.profiles ?? {}).filter(
        ([, profile]) => profile.provider.trim().toLowerCase() === CRABBOX_WORKER_PROVIDER_ID,
      );
      if (profiles.length === 0) {
        return [];
      }
      const probes = new Map<string, ReturnType<typeof doctorRuntime.probeCrabboxVersion>>();
      const findings: HealthFinding[] = [];
      for (const [profileId, profile] of profiles) {
        const explicitBinary = nonEmptyString(readRecord(profile.settings)?.binary);
        const binary = findCrabboxBinary({
          ...(explicitBinary ? { explicit: explicitBinary } : {}),
          openclawRoot,
          pathEnv: ctx.env?.PATH ?? process.env.PATH,
        });
        if (!binary) {
          findings.push(
            finding({
              profileId,
              ...(explicitBinary ? { binary: explicitBinary } : {}),
              message: explicitBinary
                ? `cannot use Crabbox because ${explicitBinary} is not an executable file.`
                : "cannot resolve an executable Crabbox binary from the Gateway user's PATH.",
              fixHint: repairHint(profileId, explicitBinary),
            }),
          );
          continue;
        }
        let probe = probes.get(binary);
        if (!probe) {
          probe = doctorRuntime.probeCrabboxVersion(binary);
          probes.set(binary, probe);
        }
        const result = await probe;
        if (result.status === "outdated") {
          findings.push(
            finding({
              profileId,
              binary,
              message: `uses Crabbox ${result.version}, but cloud workers require 0.41.1 or newer.`,
              fixHint: repairHint(profileId, explicitBinary),
            }),
          );
        } else if (result.status === "indeterminate") {
          findings.push(
            finding({
              profileId,
              binary,
              severity: "info",
              message: `has an executable Crabbox binary, but Doctor could not determine its version: ${result.reason}.`,
              fixHint: `Run \`${binary} --version\` and confirm it reports Crabbox 0.41.1 or newer, then rerun \`openclaw doctor --json --severity-min info\`.`,
            }),
          );
        }
      }
      return findings;
    },
  };
}

export function registerCrabboxWorkerProviderDoctorChecks(
  host: CrabboxDoctorRegistrationHost,
): void {
  if (getHealthCheck(CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID)) {
    return;
  }
  host.registerHealthCheck(createCrabboxCloudWorkerProfileCheck(host.openclawRoot));
}
