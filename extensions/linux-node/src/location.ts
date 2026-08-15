import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import {
  clamp,
  formatToolError,
  isCapabilityEnabledForHost,
  parseParams,
  readFiniteNumber,
  type RunCommand,
} from "./command-utils.js";
import type { ResolvedLinuxNodePluginConfig } from "./config.js";
import type { ExecutableResolver } from "./executables.js";

const GEOCLUE_DEMO_PATHS = [
  "/usr/libexec/geoclue-2.0/demos/where-am-i",
  "/usr/lib/geoclue-2.0/demos/where-am-i",
] as const;
const GEOCLUE_TIMESTAMP_RESOLUTION_MS = 1000;

type LocationCommandDeps = {
  config: ResolvedLinuxNodePluginConfig;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  resolveExecutable: ExecutableResolver;
  runCommand: RunCommand;
  now: () => Date;
};

function isLocationDisabledOutput(output: string): boolean {
  // GeoClue reports both an explicit disable and, on headless hosts without an
  // authorization agent, an access-denied error; both mean "not permitted here".
  return /Geolocation disabled|disallowed, no agent|AccessDenied|not authorized/iu.test(output);
}

function parseLocationOutput(
  output: string,
  now: () => Date,
  maxAgeMs?: number,
): {
  lat: number;
  lon: number;
  accuracyMeters: number;
  altitudeMeters?: number;
  speedMps?: number;
  headingDeg?: number;
  timestamp: string;
} | null {
  const blocks = output.split(/\nNew location:\s*\n/gu);
  for (const block of blocks.toReversed()) {
    const latitude = /Latitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const longitude = /Longitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const accuracy = /Accuracy:\s*([-+\d.]+)/u.exec(block)?.[1];
    if (latitude === undefined || longitude === undefined || accuracy === undefined) {
      continue;
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    const accuracyMeters = Number(accuracy);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(accuracyMeters) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      accuracyMeters < 0
    ) {
      continue;
    }
    const epochSeconds = /\((\d+)\s+seconds since the Epoch\)/u.exec(block)?.[1];
    const altitude = /Altitude:\s*([-+\d.]+)/u.exec(block)?.[1];
    const speed = /Speed:\s*([-+\d.]+)/u.exec(block)?.[1];
    const heading = /Heading:\s*([-+\d.]+)/u.exec(block)?.[1];
    const timestamp = epochSeconds
      ? new Date(Number(epochSeconds) * 1000).toISOString()
      : now().toISOString();
    if (
      maxAgeMs !== undefined &&
      now().getTime() - Date.parse(timestamp) >= maxAgeMs + GEOCLUE_TIMESTAMP_RESOLUTION_MS
    ) {
      continue;
    }
    return {
      lat,
      lon,
      accuracyMeters,
      ...(altitude !== undefined ? { altitudeMeters: Number(altitude) } : {}),
      ...(speed !== undefined ? { speedMps: Number(speed) } : {}),
      ...(heading !== undefined ? { headingDeg: Number(heading) } : {}),
      timestamp,
    };
  }
  return null;
}

export function createLinuxLocationCommand(
  deps: LocationCommandDeps,
): OpenClawPluginNodeHostCommand {
  const findWhereAmI = (env = deps.env) =>
    deps.resolveExecutable("where-am-i", env, GEOCLUE_DEMO_PATHS);
  return {
    command: "location.get",
    cap: "location",
    isAvailable: (context) =>
      deps.platform === "linux" &&
      isCapabilityEnabledForHost(context, "location") &&
      findWhereAmI(context.env) !== null,
    handle: async (paramsJSON) => {
      if (deps.platform !== "linux") {
        throw new Error("LOCATION_DISABLED: Linux node host required");
      }
      if (!deps.config.location.enabled) {
        throw new Error(
          "LOCATION_DISABLED: enable plugins.entries.linux-node.config.location.enabled and restart the node service",
        );
      }
      const whereAmI = findWhereAmI();
      if (!whereAmI) {
        throw new Error("LOCATION_UNAVAILABLE: where-am-i not found");
      }
      const params = parseParams(paramsJSON);
      const timeoutMs = clamp(
        Math.floor(readFiniteNumber(params.timeoutMs) ?? 10_000),
        1000,
        60_000,
      );
      const maxAgeMsRaw = readFiniteNumber(params.maxAgeMs);
      const maxAgeMs = maxAgeMsRaw !== undefined && maxAgeMsRaw >= 0 ? maxAgeMsRaw : undefined;
      const desiredAccuracy =
        params.desiredAccuracy === "coarse" ? 4 : params.desiredAccuracy === "precise" ? 8 : 6;
      let streamedOutput = "";
      let observedTimestamps = 0;
      const result = await deps.runCommand(
        // where-am-i `-t` is "exit after T seconds" (a process timeout), not the
        // `-i` time-threshold (update throttle, default 0), so no fix is withheld.
        [whereAmI, "-t", String(Math.ceil(timeoutMs / 1000)), "-a", String(desiredAccuracy)],
        {
          timeoutMs: timeoutMs + 3000,
          maxOutputBytes: { stdout: 64 * 1024, stderr: 16 * 1024 },
          outputCapture: "tail",
          env: { LC_ALL: "C", LANG: "C" },
          onOutputChunk: (chunk, stream) => {
            if (stream !== "stdout") {
              return true;
            }
            streamedOutput = `${streamedOutput}${chunk.toString("utf8")}`.slice(-64 * 1024);
            if (isLocationDisabledOutput(streamedOutput)) {
              return false;
            }
            const timestampCount = [
              ...streamedOutput.matchAll(/Timestamp:\s*.*seconds since the Epoch\)/gu),
            ].length;
            if (timestampCount === observedTimestamps) {
              return true;
            }
            observedTimestamps = timestampCount;
            return parseLocationOutput(streamedOutput, deps.now, maxAgeMs) === null;
          },
        },
      );
      const toolOutput = `${result.stdout}\n${result.stderr}\n${streamedOutput}`;
      if (isLocationDisabledOutput(toolOutput)) {
        throw new Error("LOCATION_DISABLED: GeoClue location services are disabled");
      }
      const location = parseLocationOutput(
        `${result.stdout}\n${streamedOutput}`,
        deps.now,
        maxAgeMs,
      );
      if (!location) {
        if (result.termination === "timeout" || result.code === 0) {
          throw new Error("LOCATION_TIMEOUT: no fix in time");
        }
        throw new Error(`LOCATION_UNAVAILABLE: ${formatToolError(result)}`);
      }
      return JSON.stringify({
        ...location,
        isPrecise: location.accuracyMeters <= 100,
        source: "unknown",
      });
    },
  };
}
