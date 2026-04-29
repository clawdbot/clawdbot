import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "./docker-e2e-scenarios.mjs";

export const PLUGIN_PRERELEASE_REQUIRED_SURFACES = Object.freeze([
  "package-artifact",
  "bundled-lifecycle",
  "external-plugins",
  "update-no-op",
  "channel-runtime-deps",
  "doctor-fix",
  "config-round-trip",
  "gateway-bootstrap",
  "sdk-compatibility",
  "status-diagnostics",
  "npm-registry-plugin",
  "clawhub-registry-plugin",
  "resource-guardrails",
  "live-ish-availability",
]);

const pluginPrereleaseDockerLanes = Object.freeze([
  {
    lane: "npm-onboard-channel-agent",
    surfaces: ["package-artifact", "gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "doctor-switch",
    surfaces: ["package-artifact", "doctor-fix"],
  },
  {
    lane: "update-channel-switch",
    surfaces: ["package-artifact", "channel-runtime-deps", "update-no-op"],
  },
  {
    lane: "bundled-channel-deps-compat",
    surfaces: ["package-artifact", "channel-runtime-deps", "gateway-bootstrap"],
  },
  {
    lane: "plugins-offline",
    surfaces: ["external-plugins", "sdk-compatibility", "status-diagnostics"],
  },
  {
    lane: "plugins",
    surfaces: ["external-plugins", "sdk-compatibility", "status-diagnostics"],
  },
  {
    lane: "kitchen-sink-plugin",
    surfaces: [
      "external-plugins",
      "sdk-compatibility",
      "status-diagnostics",
      "npm-registry-plugin",
      "clawhub-registry-plugin",
      "resource-guardrails",
    ],
  },
  {
    lane: "plugin-update",
    surfaces: ["package-artifact", "update-no-op"],
  },
  {
    lane: "config-reload",
    surfaces: ["config-round-trip", "gateway-bootstrap"],
  },
  {
    lane: "gateway-network",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "mcp-channels",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  {
    lane: "cron-mcp-cleanup",
    surfaces: ["gateway-bootstrap", "status-diagnostics"],
  },
  ...Array.from({ length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS }, (_, index) => ({
    lane: `bundled-plugin-install-uninstall-${index}`,
    surfaces: ["bundled-lifecycle", "package-artifact", "status-diagnostics"],
  })),
]);

const staticChecks = Object.freeze([
  {
    check: "test:extensions:package-boundary:compile",
    checkName: "checks-plugin-prerelease-package-boundary-compile",
    command: "pnpm run test:extensions:package-boundary:compile",
    surfaces: ["package-artifact", "sdk-compatibility"],
  },
  {
    check: "test:extensions:package-boundary:canary",
    checkName: "checks-plugin-prerelease-package-boundary-canary",
    command: "pnpm run test:extensions:package-boundary:canary",
    surfaces: ["package-artifact", "sdk-compatibility"],
  },
  {
    check: "live-ish-availability",
    checkName: "checks-plugin-prerelease-live-ish-availability",
    command: "node scripts/plugin-prerelease-liveish-matrix.mjs",
    surfaces: ["live-ish-availability"],
  },
]);

function coveredSurfaces(entries) {
  return [
    ...new Set(
      entries
        .flatMap((entry) => entry.surfaces)
        .filter((surface) => typeof surface === "string" && surface.length > 0),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
}

export function createPluginPrereleaseTestPlan() {
  const dockerLanes = pluginPrereleaseDockerLanes.map((entry) => entry.lane);
  const allEntries = [...pluginPrereleaseDockerLanes, ...staticChecks];
  return {
    dockerLanes,
    staticChecks: staticChecks.map((entry) => ({
      check: entry.check,
      checkName: entry.checkName,
      command: entry.command,
      surfaces: entry.surfaces.slice(),
    })),
    surfaces: coveredSurfaces(allEntries),
  };
}

export function assertPluginPrereleaseTestPlanComplete(plan = createPluginPrereleaseTestPlan()) {
  const missing = PLUGIN_PRERELEASE_REQUIRED_SURFACES.filter(
    (surface) => !plan.surfaces.includes(surface),
  );
  if (missing.length > 0) {
    throw new Error(`Plugin prerelease test plan is missing surfaces: ${missing.join(", ")}`);
  }
  return plan;
}
