/** @typedef {"packaged-fresh" | "installer-fresh" | "packaged-upgrade" | "dev-update"} CrossOsSuite */

const RELEASE_SUITES = ["packaged-fresh", "installer-fresh", "packaged-upgrade"];
const SUPPORTED_SUITES = new Set([...RELEASE_SUITES, "dev-update"]);
const SUPPORTED_OS_IDS = new Set(["ubuntu", "windows", "macos"]);

/** @param {string} value @returns {value is CrossOsSuite} */
export function isSupportedCrossOsSuite(value) {
  return SUPPORTED_SUITES.has(value);
}

/** @param {string} rawFilter */
export function hasRequiredLinuxCrossOsSuites(rawFilter) {
  const filter = parseCrossOsSuiteFilter(rawFilter);
  return RELEASE_SUITES.every((suite) => filter.matches("ubuntu", suite));
}

/** @param {string} rawFilter */
export function parseCrossOsSuiteFilter(rawFilter) {
  const tokens = rawFilter
    .split(/[, ]+/u)
    .map((token) => normalizeCrossOsSuiteFilterToken(token))
    .filter(Boolean);
  if (tokens.length === 0) {
    return {
      /** @param {string} _osId @param {string} _suite */
      matches: (_osId, _suite) => true,
      tokens,
    };
  }

  const matchers = tokens.map((token) => {
    if (SUPPORTED_SUITES.has(token)) {
      return { osId: "", suite: token };
    }
    if (SUPPORTED_OS_IDS.has(token)) {
      return { osId: token, suite: "" };
    }
    for (const separator of ["/", ":", "-"]) {
      const matchedOs = [...SUPPORTED_OS_IDS].find((osId) =>
        token.startsWith(`${osId}${separator}`),
      );
      if (!matchedOs) {
        continue;
      }
      const suite = token.slice(matchedOs.length + separator.length);
      if (!SUPPORTED_SUITES.has(suite)) {
        break;
      }
      return { osId: matchedOs, suite };
    }
    throw new Error(
      `Unsupported cross_os_suite_filter token ${JSON.stringify(token)}. Use an OS id, suite id, or os/suite pair such as windows/packaged-upgrade.`,
    );
  });

  return {
    /** @param {string} osId @param {string} suite */
    matches: (osId, suite) =>
      matchers.some((matcher) => {
        const osMatches = !matcher.osId || matcher.osId === osId;
        const suiteMatches = !matcher.suite || matcher.suite === suite;
        return osMatches && suiteMatches;
      }),
    tokens,
  };
}

/** @param {string} token */
function normalizeCrossOsSuiteFilterToken(token) {
  return token
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-")
    .replace(/\s*[/:-]\s*/gu, (separator) => separator.trim())
    .replace(/\s+/gu, "-");
}
