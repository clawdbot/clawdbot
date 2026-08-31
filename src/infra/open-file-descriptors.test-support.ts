// Linux-only test support for proving failed opens release their file handles.
import fs from "node:fs";

export function listOpenFileDescriptorsForPath(targetPath: string): string[] {
  return fs.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const descriptorPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
      return descriptorPath.startsWith(targetPath) ? [descriptorPath] : [];
    } catch {
      return [];
    }
  });
}
