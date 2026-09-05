// Shared home-path display policy for core owners with distinct home selection contracts.
import path from "node:path";
import { isPathInside, normalizeWindowsPathPreservingCase } from "./path-guards.js";

/** Replace an absolute home path with its display prefix without clipping sibling paths. */
export function shortenPathWithHome(
  input: string,
  { home, prefix }: { home: string; prefix: string },
): string {
  if (input === home) {
    return prefix;
  }
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `${prefix}${input.slice(home.length)}`;
  }
  if (process.platform === "win32" && path.win32.isAbsolute(input) && isPathInside(home, input)) {
    const relative = path.win32.relative(
      normalizeWindowsPathPreservingCase(home),
      normalizeWindowsPathPreservingCase(input),
    );
    return path.win32.join(prefix, relative);
  }
  return input;
}
