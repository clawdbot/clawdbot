/** Secret-file reader for ACP command-line credentials. */
import { DEFAULT_SECRET_FILE_MAX_BYTES, readSecretFileSync } from "../infra/secret-file.js";

const MAX_SECRET_FILE_BYTES = DEFAULT_SECRET_FILE_MAX_BYTES;

/** Reads an ACP secret file with the shared secret-file size and symlink policy. */
export function readSecretFromFile(filePath: string, label: string): string {
  return readSecretFileSync(filePath, label, {
    maxBytes: MAX_SECRET_FILE_BYTES,
    rejectSymlink: true,
  });
}
