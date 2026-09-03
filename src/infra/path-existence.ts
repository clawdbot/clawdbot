import fs from "node:fs";
import { hasErrnoCode } from "./errno.js";

/** Only a definite missing leaf permits callers to treat a path as absent. */
export function pathMayExistSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return !hasErrnoCode(error, "ENOENT");
  }
}
