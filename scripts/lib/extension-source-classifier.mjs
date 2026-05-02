const CODE_FILE_RE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const DECLARATION_FILE_RE = /\.d\.ts$/u;
const RUNTIME_API_BARREL_RE = /(^|\/)runtime-api\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const PUBLIC_API_BARREL_RE = /(^|\/)api\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const TEST_LIKE_SEGMENT_RE =
  /(^|\/)(?:__tests__|fixtures|test|tests|test-fixtures|test-support|test-utils)(?:\/|$)/u;
const TEST_LIKE_FILENAME_RE =
  /(^|\/)[^/]*test-(?:support|helpers|fixtures|harness)\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const TEST_SHARED_FILENAME_RE = /(^|\/)[^/]*\.test-[^/]*\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const TEST_CANARY_FILENAME_RE = /(^|\/)__rootdir_boundary_canary__\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;
const SNAPSHOT_FILE_RE = /\.snap$/u;
const SUFFIX_SKIP_RE = /\.(?:test|spec|fixture)\./u;
const INFRA_DIR_RE = /(^|\/)(?:coverage|dist|node_modules)(?:\/|$)/u;
const INFRA_NAME_RE = /(test-harness|test-support|test-helpers|test-fixtures)/u;

function normalizeExtensionSourcePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

export function classifyBundledExtensionSourcePath(filePath) {
  const normalizedPath = normalizeExtensionSourcePath(filePath);
  const isCodeFile = CODE_FILE_RE.test(normalizedPath) && !DECLARATION_FILE_RE.test(normalizedPath);
  const isRuntimeApiBarrel = RUNTIME_API_BARREL_RE.test(normalizedPath);
  const isPublicApiBarrel = PUBLIC_API_BARREL_RE.test(normalizedPath);
  const isTestLike =
    TEST_LIKE_SEGMENT_RE.test(normalizedPath) ||
    TEST_LIKE_FILENAME_RE.test(normalizedPath) ||
    TEST_SHARED_FILENAME_RE.test(normalizedPath) ||
    TEST_CANARY_FILENAME_RE.test(normalizedPath) ||
    SUFFIX_SKIP_RE.test(normalizedPath) ||
    SNAPSHOT_FILE_RE.test(normalizedPath) ||
    INFRA_NAME_RE.test(normalizedPath);
  const isInfraArtifact = INFRA_DIR_RE.test(normalizedPath);

  return {
    normalizedPath,
    isCodeFile,
    isRuntimeApiBarrel,
    isPublicApiBarrel,
    isTestLike,
    isInfraArtifact,
    isProductionSource: isCodeFile && !isRuntimeApiBarrel && !isTestLike && !isInfraArtifact,
  };
}
