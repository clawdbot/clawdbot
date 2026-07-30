// Constants and path guards for local-only build metadata in dist output.
/** File written after local package build completion. */
export const BUILD_STAMP_FILE = ".buildstamp";
/** File written after runtime postbuild sync completion. */
export const RUNTIME_POSTBUILD_STAMP_FILE = ".runtime-postbuildstamp";

/**
 * Dist paths that contain local build metadata and should not be packaged as source.
 * @internal Shared repository-script contract.
 */
export const LOCAL_BUILD_METADATA_DIST_PATHS = Object.freeze([
  `dist/${BUILD_STAMP_FILE}`,
  `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`,
]);

const LOCAL_BUILD_METADATA_DIST_PATH_SET = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);

/** Return whether a dist-relative path is local build metadata. */
export function isLocalBuildMetadataDistPath(relativePath) {
  return LOCAL_BUILD_METADATA_DIST_PATH_SET.has(relativePath);
}
