import { closeSync, fstatSync, openSync } from "node:fs";
import { readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";

/** Default max file size for a single SKILL.md. Matches workspace skill loading limit. */
export const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

/**
 * Read SKILL.md content through a pinned descriptor to avoid TOCTOU races
 * and bound memory on oversized files.
 * Emits an operator-visible warning and throws on oversized input.
 *
 * Kept in a dependency-light leaf module so prompt-expansion callers
 * do not pull in the full session loader graph (workshop curator,
 * SQLite runtime, archive, ignore rules, etc.).
 */
export function readBoundedSkillFile(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_SKILL_FILE_BYTES,
): string {
  const fd = openSync(filePath, "r");
  try {
    const stats = fstatSync(fd);
    if (stats.size > maxBytes) {
      console.warn(`Skill file rejected (exceeds ${maxBytes} bytes): ${filePath}`);
      throw Object.assign(new Error(`skill file exceeds ${maxBytes} bytes (${stats.size} bytes)`), {
        code: "E2BIG",
      });
    }
    try {
      return readFileDescriptorBoundedSync(fd, maxBytes).toString("utf-8");
    } catch (error) {
      if (error instanceof RangeError) {
        console.warn(`Skill file rejected (exceeds ${maxBytes} bytes): ${filePath}`);
        throw Object.assign(new Error(`skill file exceeds ${maxBytes} bytes`), {
          code: "E2BIG",
        });
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
