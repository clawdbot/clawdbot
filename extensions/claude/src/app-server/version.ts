/**
 * Bridge version contract for the Claude harness.
 *
 * The extension drives a separately-published binary
 * (@zeroaltitude/openclaw-claude-bridge) over stdio. Because operators install
 * and upgrade that binary independently (the supported dev loop is
 * `npm i -g @zeroaltitude/openclaw-claude-bridge`), the version the gateway
 * actually spawns can drift from what the plugin expects. This module is the
 * single source of truth for the required floor and the comparison helper used
 * to detect skew, mirroring extensions/codex/src/app-server/version.ts.
 */

export const MANAGED_CLAUDE_BRIDGE_PACKAGE = "@zeroaltitude/openclaw-claude-bridge";

/**
 * Minimum bridge version the extension requires at runtime. 0.2.11 shipped the
 * periodic 30s heartbeat (server turn-runner.ts) that keeps the extension's
 * notification idle watchdog (run-attempt.ts, 90s) alive during genuine SDK
 * silence — cold-cache 1M-context reads and native Task subagents. Older
 * bridges only have the activity-driven heartbeat, so the 90s watchdog fires as
 * "model did not produce a response before the model idle timeout" whenever the
 * SDK is legitimately quiet.
 *
 * Must stay <= the dependency pin in extensions/claude/package.json (enforced by
 * version.test.ts): the floor cannot refuse a binary the package itself blesses.
 * Raise it only in the same change that makes the extension depend on a newer
 * bridge contract — bumping it is a deliberate fail-closed decision that can
 * refuse an older-but-working global install until the operator upgrades.
 */
export const MIN_CLAUDE_BRIDGE_VERSION = "0.2.11";

/**
 * Minimum bridge version whose `thread/refresh_tools` may be trusted.
 *
 * This is a FEATURE gate, deliberately not a bump of MIN_CLAUDE_BRIDGE_VERSION:
 * an older bridge is still perfectly usable, it just has to be routed down the
 * rotation path instead of the in-place refresh. Raising the hard floor would
 * refuse those working installs outright, which extensions/claude's version
 * contract reserves for changes the extension genuinely cannot tolerate.
 *
 * Why a version gate is the ONLY way to detect this (openclaw-d42b): bridges
 * before 0.7.6 answer `{ refreshed: true }` and then break the session. They
 * forwarded our shape-only `{ type: "sdk", name: "openclaw" }` entry straight to
 * the SDK's `Query.setMcpServers`, which uses the presence of `instance` as its
 * desired-state signal — so the in-process MCP transport was disconnected while
 * the CLI kept advertising and routing `mcp__openclaw__*`. Every subsequent tool
 * call in that session failed with `SDK MCP server not found: openclaw`, for the
 * whole life of the attempt (the bridge re-fingerprints on refresh precisely so
 * the attempt is NOT respawned, which pinned the broken state in place). Those
 * bridges also never applied the new catalog at all, so a policy narrowing we
 * believed had taken effect silently hadn't.
 *
 * There is no capability flag, no error, and no observable difference in the
 * response to distinguish a pre-fix bridge from a fixed one — `refreshed: true`
 * is returned in both cases. So the reported version is the only signal, and
 * being wrong is expensive (a wedged session that does not self-heal for 30
 * minutes). Hence: gate, and rotate when below.
 */
export const MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH = "0.7.6";

/**
 * Compare two semver-shaped bridge versions on their numeric major.minor.patch
 * prefix. Returns a negative number if `left` is below `right`, zero if equal,
 * positive if above. An `undefined` `left` is treated as below any concrete
 * floor so an unknown running version fails the gate.
 *
 * Prerelease (`-`) and build-metadata (`+`) suffixes mark a version as below the
 * same stable release: a `0.2.11-beta.1` does not satisfy a `0.2.11` floor,
 * because contract-relevant changes can land between a prerelease cut and the
 * release. This matches extensions/codex/src/app-server/client.ts
 * (parseVersionForComparison) rather than the upstream bridge's
 * version-compare.ts, which treats prerelease as equal to the release.
 *
 * Duplicated on the consumer side rather than imported from the bridge package:
 * the bridge is a separately-published package and the extensions boundary
 * (extensions/CLAUDE.md) forbids reaching outside the plugin's own package.
 */
export function compareClaudeBridgeVersions(left: string | undefined, right: string): number {
  if (!left) {
    return -1;
  }
  const lhs = parseBridgeVersion(left);
  const rhs = parseBridgeVersion(right);
  const length = Math.max(lhs.parts.length, rhs.parts.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs.parts[index] ?? 0;
    const b = rhs.parts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  if (lhs.unstable && !rhs.unstable) {
    return -1;
  }
  if (!lhs.unstable && rhs.unstable) {
    return 1;
  }
  return 0;
}

function parseBridgeVersion(version: string): { parts: number[]; unstable: boolean } {
  const hasBuildMetadata = version.includes("+");
  const [withoutBuild = version] = version.split("+", 1);
  const prereleaseIndex = withoutBuild.indexOf("-");
  const numeric = prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild;
  return {
    parts: numeric.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    }),
    unstable: prereleaseIndex >= 0 || hasBuildMetadata,
  };
}
