export const BUILD_STAMP_FILE = ".buildstamp";
export const RUNTIME_POSTBUILD_STAMP_FILE = ".runtime-postbuildstamp";

export const LOCAL_BUILD_METADATA_DIST_PATHS = Object.freeze([
  `dist/${BUILD_STAMP_FILE}`,
  `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`,
]);

const LOCAL_BUILD_METADATA_DIST_PATH_SET = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);

export function isLocalBuildMetadataDistPath(relativePath) {
  return LOCAL_BUILD_METADATA_DIST_PATH_SET.has(relativePath);
}
