import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import { CRABBOX_WORKER_PROVIDER_ID, findCrabboxBinary } from "./crabbox-worker-profile.js";
import {
  crabboxWarmImageRecoveryHint,
  isCrabboxWarmImageCapturePaused,
  listCrabboxWarmImages,
} from "./crabbox-worker-warm-image-store.js";

export const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";

type CrabboxDoctorRegistrationHost = {
  readonly openclawRoot: string;
  readonly getHealthCheck: (id: string) => HealthCheck | undefined;
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
    description: "Verify configured Crabbox cloud worker profiles before dispatch.",
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
        const settings = readRecord(profile.settings);
        const explicitBinary = nonEmptyString(settings?.binary);
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
  // Lookup and registration must use the same host registry across artifact loaders.
  if (!host.getHealthCheck(CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID)) {
    host.registerHealthCheck(createCrabboxCloudWorkerProfileCheck(host.openclawRoot));
  }
  if (!host.getHealthCheck(CRABBOX_WARM_IMAGES_CHECK_ID)) {
    host.registerHealthCheck({
      id: CRABBOX_WARM_IMAGES_CHECK_ID,
      kind: "plugin",
      description: "Report paused Crabbox warm-image captures and retained cleanup obligations.",
      source: "crabbox",
      async detect(ctx) {
        const findings: HealthFinding[] = [];
        for (const image of listCrabboxWarmImages(ctx.env)) {
          const details = {
            checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
            severity: "warning",
            source: "crabbox",
            target: image.profileKey,
          } as const;
          if (image.capture) {
            const paused = isCrabboxWarmImageCapturePaused(image.capture);
            findings.push({
              ...details,
              severity: paused ? "warning" : "info",
              message: paused
                ? `Warm-image capture ${image.capture.selector} is paused; its provider outcome requires manual reconciliation.`
                : `Warm-image capture ${image.capture.selector} is in progress.`,
              fixHint: paused
                ? crabboxWarmImageRecoveryHint(image.capture.selector)
                : "Allow the current capture to finish; inspect `openclaw crabbox warm-images --json` if it remains pending.",
            });
          }
          if (image.retirement) {
            findings.push({
              ...details,
              message: `Warm-image checkpoint ${image.retirement.checkpointId} is still awaiting deletion.`,
              fixHint:
                "Cleanup retries during the next Crabbox worker allocation or capture. Inspect `openclaw crabbox warm-images --json` and resolve provider deletion errors if it remains pending.",
            });
          }
        }
        return findings;
      },
    });
  }
}
