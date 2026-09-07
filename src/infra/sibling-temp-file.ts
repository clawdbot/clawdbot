// Exposes sibling temp file writes with fs-safe defaults.
import "./fs-safe-defaults.js";
// Atomic sibling temp writes preserve target-directory permissions and avoid
// cross-device rename behavior.
import {
  writeSiblingTempFile as writeSiblingTempFileBase,
  type WriteSiblingTempFileOptions,
} from "@openclaw/fs-safe/advanced";
import { writeOwnedTempFile } from "./owned-temp-file.js";

export async function writeSiblingTempFile<T>(options: WriteSiblingTempFileOptions<T>) {
  return await writeSiblingTempFileBase({
    ...options,
    writeTemp: (tempPath) => writeOwnedTempFile(tempPath, options.writeTemp),
  });
}
