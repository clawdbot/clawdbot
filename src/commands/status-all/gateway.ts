import fs from "node:fs/promises";

export async function readFileTailLines(
  filePath: string,
  maxLines: number,
): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const lines = raw.replace(/\r/g, "").split("\n");
  const out = lines.slice(Math.max(0, lines.length - maxLines));
  return out
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function pickGatewaySelfPresence(presence: unknown): {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
} | null {
  if (!Array.isArray(presence)) return null;
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? null;
  if (!self) return null;
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}
