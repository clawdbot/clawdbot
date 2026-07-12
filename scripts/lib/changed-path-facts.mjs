const DOCS_PATH_RE = /^(?:docs\/|README\.md$|AGENTS\.md$|.*\.mdx?$)/u;
const APP_PATH_RE = /^(?:apps\/|Swabble\/|appcast\.xml$)/u;
const EXTENSION_PATH_RE = /^extensions\/[^/]+(?:\/|$)/u;
const SOURCE_PATH_RE = /^src\//u;
const PACKAGE_PATH_RE = /^packages\//u;
const UI_PATH_RE = /^(?:ui\/|tsconfig\.ui\.json$)/u;
const ROOT_TEST_PATH_RE = /^test\//u;
const TEST_FIXTURE_PATH_RE = /^test-fixtures\//u;
const ROOT_TOOLING_PATH_RE =
  /^(?:scripts\/|test\/vitest\/|\.github\/|\.vscode\/|config\/|deploy\/|git-hooks\/|Dockerfile\.sandbox(?:-(?:browser|common))?$|Makefile$|docker-setup\.sh$|setup-podman\.sh$|openclaw\.podman\.env$|skills\/pyproject\.toml$|vitest(?:\..+)?\.config\.ts$|tsconfig.*\.json$|\.dockerignore$|\.gitignore$|\.jscpd\.json$|\.npmignore$|\.pre-commit-config\.yaml$|\.swiftformat$|\.swiftlint\.yml$|\.oxlint.*|\.oxfmt.*)/u;
const ROOT_GLOBAL_PATH_RE =
  /^(?:package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsdown\.config\.ts$|vitest\.config\.ts$)/u;
const LEGACY_ROOT_ASSET_PATH_RE = /^assets\//u;
const CHANGED_LANE_TEST_PATH_RE =
  /(?:^|\/)(?:test|__tests__)\/|(?:\.|\/)(?:test|spec|e2e|browser\.test)\.[cm]?[jt]sx?$/u;
const TEST_ONLY_PATH_RE =
  /(^test\/|\/test\/|\/tests\/|(?:^|\/)[^/]+\.(?:test|spec|test-utils|test-support|test-harness|e2e-harness)\.[cm]?[jt]sx?$)/u;
const NATIVE_ONLY_PATH_RE =
  /^(?:apps\/android\/|apps\/ios\/|apps\/macos\/|apps\/macos-mlx-tts\/|apps\/shared\/|apps\/swabble\/|Swabble\/|appcast\.xml$)/u;

/**
 * @typedef {"docs" | "source" | "package" | "ui" | "extension" | "app" | "rootTest" | "testFixture" | "rootTooling" | "rootGlobal" | "legacyRootAsset" | "unknown"} ChangedPathSurface
 */

/**
 * Normalizes a changed file path into repo-relative POSIX form.
 */
export function normalizeChangedPath(inputPath) {
  return String(inputPath ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

/**
 * Returns shared path facts without imposing a caller's lane-selection policy.
 */
export function getChangedPathFacts(inputPath) {
  const path = String(inputPath ?? "").trim();
  let surface = /** @type {ChangedPathSurface} */ ("unknown");

  if (DOCS_PATH_RE.test(path)) {
    surface = "docs";
  } else if (ROOT_GLOBAL_PATH_RE.test(path)) {
    surface = "rootGlobal";
  } else if (EXTENSION_PATH_RE.test(path)) {
    surface = "extension";
  } else if (SOURCE_PATH_RE.test(path)) {
    surface = "source";
  } else if (PACKAGE_PATH_RE.test(path)) {
    surface = "package";
  } else if (UI_PATH_RE.test(path)) {
    surface = "ui";
  } else if (APP_PATH_RE.test(path)) {
    surface = "app";
  } else if (ROOT_TEST_PATH_RE.test(path)) {
    surface = "rootTest";
  } else if (TEST_FIXTURE_PATH_RE.test(path)) {
    surface = "testFixture";
  } else if (ROOT_TOOLING_PATH_RE.test(path)) {
    surface = "rootTooling";
  } else if (LEGACY_ROOT_ASSET_PATH_RE.test(path)) {
    surface = "legacyRootAsset";
  }

  return {
    path,
    surface,
    isChangedLaneTest: CHANGED_LANE_TEST_PATH_RE.test(path),
    isTestOnly: TEST_ONLY_PATH_RE.test(path),
    isNativeOnly: NATIVE_ONLY_PATH_RE.test(path),
  };
}
