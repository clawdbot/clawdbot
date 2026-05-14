import path from "node:path";

export function basenameFromAnyPath(value: string): string {
  return path.win32.basename(path.posix.basename(value));
}

export function extnameFromAnyPath(value: string): string {
  return path.extname(basenameFromAnyPath(value));
}

export function nameFromAnyPath(value: string): string {
  const base = basenameFromAnyPath(value);
  const ext = path.extname(base);
  return path.basename(base, ext);
}
