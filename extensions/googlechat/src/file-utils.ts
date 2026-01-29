import fs from "node:fs";

/**
 * Reads and parses a JSON file. Returns null if the file doesn't exist,
 * is empty, or cannot be parsed. Logs meaningful errors for debugging.
 */
export function readJsonFile(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    // Log meaningful errors (permission issues, malformed JSON) for debugging
    if (err instanceof Error && err.message && !err.message.includes("ENOENT")) {
      console.error(`Failed to read or parse JSON file ${filePath}`);
    }
    return null;
  }
}

/**
 * Extracts a refresh token from a JSON object that may have either
 * `refresh_token` or `refreshToken` property.
 */
export function extractRefreshTokenFromRecord(record: Record<string, unknown>): string | null {
  const token =
    typeof record.refresh_token === "string"
      ? record.refresh_token.trim()
      : typeof record.refreshToken === "string"
        ? record.refreshToken.trim()
        : undefined;
  if (token && token.length > 0) return token;
  return null;
}

/**
 * Reads a refresh token from a file. The file may contain either:
 * - A plain string token
 * - A JSON object with refresh_token or refreshToken property
 */
export function readRefreshTokenFromFile(filePath: string): string | null {
  const raw = readJsonFile(filePath);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    return extractRefreshTokenFromRecord(raw as Record<string, unknown>);
  }
  return null;
}
