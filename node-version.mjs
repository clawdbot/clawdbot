// Zero-dependency Node release-version contract shared by source and packaged entry points.
const NODE_RELEASE_VERSION_RE =
  /^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const MIN_NODE_22 = { major: 22, minor: 22, patch: 3 };
const MIN_NODE_24 = { major: 24, minor: 15, patch: 0 };
const MIN_NODE_25 = { major: 25, minor: 9, patch: 0 };

/** Parses an anchored release SemVer, allowing a leading v and valid build metadata. */
export function parseNodeReleaseVersion(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = NODE_RELEASE_VERSION_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  return Object.values(version).every(Number.isSafeInteger) ? version : null;
}

export function isNodeVersionAtLeast(version, minimum) {
  if (!version) {
    return false;
  }
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

/** Checks OpenClaw's supported release lines. Node 23 remains unsupported. */
export function isSupportedOpenClawNodeVersion(value) {
  const version = parseNodeReleaseVersion(value);
  if (!version) {
    return false;
  }
  if (version.major === MIN_NODE_22.major) {
    return isNodeVersionAtLeast(version, MIN_NODE_22);
  }
  if (version.major === MIN_NODE_24.major) {
    return isNodeVersionAtLeast(version, MIN_NODE_24);
  }
  if (version.major === MIN_NODE_25.major) {
    return isNodeVersionAtLeast(version, MIN_NODE_25);
  }
  return version.major > MIN_NODE_25.major;
}
