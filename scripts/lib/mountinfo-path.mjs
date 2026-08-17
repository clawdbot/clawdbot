// Decodes octal-escaped path fields in Linux procfs mount tables.

// The kernel escapes space, tab, newline, and backslash as \040, \011, \012, and
// \134 in the mount-root and mount-point fields of /proc/self/mountinfo, so a
// verbatim comparison silently fails to match any path containing one of them.
const MOUNT_PATH_OCTAL_ESCAPE_RE = /\\([0-7]{3})/g;

/**
 * Decode a procfs mount-table path field into its real path.
 * @param {string} value
 * @returns {string}
 */
export function decodeMountInfoPath(value) {
  return value.replace(MOUNT_PATH_OCTAL_ESCAPE_RE, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
