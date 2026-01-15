import fs from "node:fs/promises";

export async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      ok: true,
      isSymlink: lst.isSymbolicLink(),
      isDir: lst.isDirectory(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      uid: typeof lst.uid === "number" ? lst.uid : null,
      gid: typeof lst.gid === "number" ? lst.gid : null,
    };
  } catch (err) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      uid: null,
      gid: null,
      error: String(err),
    };
  }
}

export function modeBits(mode: number | null): number | null {
  if (mode == null) return null;
  return mode & 0o777;
}

export function formatOctal(bits: number | null): string {
  if (bits == null) return "unknown";
  return bits.toString(8).padStart(3, "0");
}

export function isWorldWritable(bits: number | null): boolean {
  if (bits == null) return false;
  return (bits & 0o002) !== 0;
}

export function isGroupWritable(bits: number | null): boolean {
  if (bits == null) return false;
  return (bits & 0o020) !== 0;
}

export function isWorldReadable(bits: number | null): boolean {
  if (bits == null) return false;
  return (bits & 0o004) !== 0;
}

export function isGroupReadable(bits: number | null): boolean {
  if (bits == null) return false;
  return (bits & 0o040) !== 0;
}
