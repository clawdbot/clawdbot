const CONTROL_UI_LOCALE_BUNDLE_PATTERN = /^ui\/src\/i18n\/locales\/[^/]+\.ts$/u;
const GENERATED_SEGMENT_PATTERN = /(^|\/)(?:__generated__|generated)(?:\/|$)/u;
const GENERATED_SUFFIX_PATTERN = /\.generated(?:\.d)?\.[cm]?tsx?$/u;
const TEST_LIKE_SEGMENT_PATTERN =
  /(^|\/)(?:__tests__|fixtures|mocks?|test|tests|test-fixtures?|test-helpers?|test-support|test-utils?)(?:\/|$)/u;
const TEST_LIKE_SUFFIX_PATTERN = /\.(?:e2e|fixture|mocks?|spec|suite|test)\.[cm]?tsx?$/u;
const TEST_HELPER_PATH_TOKEN_PATTERN =
  /(?:^|[/.-])test-(?:fixtures?|harness|helpers?|support|utils?)(?:[/.-]|$)/u;
const TEST_HELPER_STEM_PATTERN =
  /(?:^|[.-])(?:e2e-harness|mock-(?:harness|setup))(?:\.|$)|(?:^|\.)mocks(?:\.|$)|(?:^|\.)[^.]*-mocks?(?:\.|$)/u;

function typeScriptStem(filePath) {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  return basename.replace(/\.(?:ts|tsx|mts|cts)$/u, "");
}

/** Returns whether a path is production TypeScript governed by the LOC ratchet. */
export function isProductionTypeScriptFile(filePath) {
  return (
    /\.(?:ts|tsx|mts|cts)$/u.test(filePath) &&
    !CONTROL_UI_LOCALE_BUNDLE_PATTERN.test(filePath) &&
    !GENERATED_SEGMENT_PATTERN.test(filePath) &&
    !GENERATED_SUFFIX_PATTERN.test(filePath) &&
    !TEST_LIKE_SEGMENT_PATTERN.test(filePath) &&
    !TEST_LIKE_SUFFIX_PATTERN.test(filePath) &&
    !TEST_HELPER_PATH_TOKEN_PATTERN.test(filePath) &&
    !TEST_HELPER_STEM_PATTERN.test(typeScriptStem(filePath))
  );
}
