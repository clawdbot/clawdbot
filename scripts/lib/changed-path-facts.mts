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
  [
    "rootTooling",
    /^(?:scripts\/|test\/vitest\/|\.github\/|\.vscode\/|config\/|deploy\/|git-hooks\/|Dockerfile\.sandbox(?:-(?:browser|common))?$|Makefile$|docker-setup\.sh$|setup-podman\.sh$|openclaw\.podman\.env$|skills\/pyproject\.toml$|vitest(?:\..+)?\.config\.ts$|tsconfig.*\.json$|\.dockerignore$|\.gitignore$|\.jscpd\.json$|\.npmignore$|\.pre-commit-config\.yaml$|\.swiftformat$|\.swiftlint\.yml$|\.oxlint.*|\.oxfmt.*)/u,
  ],
  ["legacyRootAsset", /^assets\//u],
] as const satisfies readonly (readonly [string, RegExp])[];
const CHANGED_LANE_TEST_PATH_RE =
  /(?:^|\/)(?:test|__tests__)\/|(?:\.|\/)(?:test|spec|e2e|browser\.test)\.[cm]?[jt]sx?$|(?:^|\/)[^/]+\.test-(?:helpers|support)\.[cm]?[jt]sx?$/u;
const TEST_ONLY_PATH_RE =
  /(^test\/|\/test\/|\/tests\/|(?:^|\/)[^/]+\.(?:test|spec|test-utils|test-(?:helpers|support|harness)|e2e-harness)\.[cm]?[jt]sx?$)/u;
const NATIVE_ONLY_PATH_RE =
  /^(?:apps\/android\/|apps\/ios\/|apps\/macos\/|apps\/macos-mlx-tts\/|apps\/shared\/|apps\/swabble\/|Swabble\/|appcast\.xml$)/u;

/**
 * Normalizes a changed file path into repo-relative POSIX form.
 */
export function normalizeChangedPath(inputPath: unknown) {
  return (typeof inputPath === "string" ? inputPath : "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

/**
 * Returns shared path facts without imposing a caller's lane-selection policy.
 */
export function getChangedPathFacts(inputPath: unknown) {
  const path = typeof inputPath === "string" ? inputPath.trim() : "";
  const surface = SURFACE_PATTERNS.find(([, pattern]) => pattern.test(path))?.[0] ?? "unknown";

  return {
    path,
    surface,
    isChangedLaneTest: CHANGED_LANE_TEST_PATH_RE.test(path),
    isTestOnly: TEST_ONLY_PATH_RE.test(path),
    isNativeOnly: NATIVE_ONLY_PATH_RE.test(path),
  };
}
