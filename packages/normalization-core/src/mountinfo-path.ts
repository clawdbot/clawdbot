const MOUNT_PATH_OCTAL_ESCAPE_RE = /\\([0-7]{3})/g;

/** Decodes an octal-escaped path field from a Linux procfs mount table. */
export function decodeMountInfoPath(value: string): string {
  return value.replace(MOUNT_PATH_OCTAL_ESCAPE_RE, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}
