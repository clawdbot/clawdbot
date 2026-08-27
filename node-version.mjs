// Zero-dependency Node release-version contract shared by source and packaged entry points.
const NODE_RELEASE_VERSION_RE =
  /^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const NODE_RELEASE_FLOORS = [
  { major: 22, minor: 22, patch: 3 },
  { major: 24, minor: 15, patch: 0 },
  { major: 25, minor: 9, patch: 0 },
];
const HIGHEST_RELEASE_FLOOR = NODE_RELEASE_FLOORS[NODE_RELEASE_FLOORS.length - 1];

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
  const minimum = NODE_RELEASE_FLOORS.find((floor) => floor.major === version.major);
  return minimum
    ? isNodeVersionAtLeast(version, minimum)
    : version.major > HIGHEST_RELEASE_FLOOR.major;
}

function renderProcessNodeVersionCheck() {
  const patternSource = JSON.stringify(NODE_RELEASE_VERSION_RE.source);
  const releaseFloors = JSON.stringify(NODE_RELEASE_FLOORS);
  return `((value) => {
  if (typeof value !== "string") return false;
  const match = new RegExp(${patternSource}, "u").exec(value.trim());
  if (!match) return false;
  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (!Object.values(version).every(Number.isSafeInteger)) return false;
  const floors = ${releaseFloors};
  const minimum = floors.find((floor) => floor.major === version.major);
  const atLeast = (floor) =>
    version.major > floor.major ||
    (version.major === floor.major &&
      (version.minor > floor.minor ||
        (version.minor === floor.minor && version.patch >= floor.patch)));
  return minimum ? atLeast(minimum) : version.major > floors[floors.length - 1].major;
})(process.versions.node)`;
}

// Worker bootstrap runs before OpenClaw is transferred. Carry the canonical
// release policy as a self-contained expression instead of a second parser.
export const PROCESS_NODE_VERSION_CHECK = renderProcessNodeVersionCheck();
