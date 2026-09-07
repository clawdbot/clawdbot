/**
 * @typedef {"docs" | "source" | "package" | "ui" | "extension" | "app" | "rootTest" | "testFixture" | "rootTooling" | "rootGlobal" | "legacyRootAsset" | "unknown"} ChangedPathSurface
 */

/** @type {readonly (readonly [ChangedPathSurface, RegExp])[]} */
const SURFACE_PATTERNS = [
  ["docs", /^(?:docs\/|README\.md$|AGENTS\.md$|.*\.mdx?$)/u],
  [
    "rootGlobal",
    /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsdown\.config\.ts$|vitest\.config\.ts$)/u,
  ],
  ["extension", /^extensions\/[^/]+(?:\/|$)/u],
  ["source", /^src\//u],
  ["package", /^packages\//u],
  ["ui", /^(?:ui\/|tsconfig\.ui\.json$)/u],
  ["app", /^(?:apps\/|Swabble\/|appcast\.xml$)/u],
  ["rootTest", /^test\//u],
  ["testFixture", /^test-fixtures\//u],
  // This hidden helper only reports maintainer activity; it has no product consumers.
  // Match the reviewed leaf exactly so unreviewed skill executables still fail safe.
  ["rootTooling", /^\.agents\/skills\/openclaw-pr-maintainer\/scripts\/github-activity\.sh$/u],
  [
    "rootTooling",
    /^(?:scripts\/|test\/vitest\/|\.github\/|\.vscode\/|config\/|deploy\/|git-hooks\/|Dockerfile\.sandbox(?:-(?:browser|common))?$|Makefile$|docker-setup\.sh$|setup-podman\.sh$|openclaw\.podman\.env$|skills\/pyproject\.toml$|vitest(?:\..+)?\.config\.ts$|tsconfig.*\.json$|\.dockerignore$|\.gitignore$|\.jscpd\.json$|\.npmignore$|\.pre-commit-config\.yaml$|\.swiftformat$|\.swiftlint\.yml$|\.oxlint.*|\.oxfmt.*)/u,
  ],
  ["legacyRootAsset", /^assets\//u],
];
const CHANGED_LANE_TEST_PATH_RE =
  /(?:^|\/)(?:test|__tests__)\/|(?:\.|\/)(?:test|spec|suite|e2e|browser\.test)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+\.test-(?:helpers|support)\.[cm]?[jt]sx?$/u;
const TEST_ONLY_PATH_RE =
  /(^test\/|\/test\/|\/tests\/|(?:^|\/)[^/]+\.(?:test|spec|suite|test-utils|test-(?:helpers|support|harness)|e2e-harness)\.[cm]?[jt]sx?$)/u;
const NATIVE_ONLY_PATH_RE =
  /^(?:apps\/android\/|apps\/ios\/|apps\/macos\/|apps\/macos-mlx-tts\/|apps\/shared\/|apps\/swabble\/|Swabble\/|appcast\.xml$)/u;
const ROOT_TEST_SOURCE_PATH_RE = /^test\/(?!fixtures\/).*\.[cm]?tsx?$/u;

/**
 * Normalizes a changed file path into repo-relative POSIX form.
 * @param {unknown} inputPath
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function normalizeChangedPath(inputPath, platform = process.platform) {
  const path = (typeof inputPath === "string" ? inputPath : "").trim();
  return (platform === "win32" ? path.replaceAll("\\", "/") : path).replace(/^\.\/+/u, "");
}

/**
 * Returns shared path facts without imposing a caller's lane-selection policy.
 * @param {unknown} inputPath
 * @returns {{ path: string; surface: ChangedPathSurface; isChangedLaneTest: boolean; isRootTestSource: boolean; isTestOnly: boolean; isNativeOnly: boolean }}
 */
export function getChangedPathFacts(inputPath) {
  const path = typeof inputPath === "string" ? inputPath : "";
  const surface = SURFACE_PATTERNS.find(([, pattern]) => pattern.test(path))?.[0] ?? "unknown";

  return {
    path,
    surface,
    isChangedLaneTest: CHANGED_LANE_TEST_PATH_RE.test(path),
    isRootTestSource: ROOT_TEST_SOURCE_PATH_RE.test(path),
    isTestOnly: TEST_ONLY_PATH_RE.test(path),
    isNativeOnly: NATIVE_ONLY_PATH_RE.test(path),
  };
}
