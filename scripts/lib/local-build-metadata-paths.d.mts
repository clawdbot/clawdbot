export const BUILD_STAMP_FILE: ".buildstamp";
export const RUNTIME_POSTBUILD_STAMP_FILE: ".runtime-postbuildstamp";
export const LOCAL_BUILD_METADATA_DIST_PATHS: readonly [
  "dist/.buildstamp",
  "dist/.runtime-postbuildstamp",
];
export function isLocalBuildMetadataDistPath(relativePath: string): boolean;
