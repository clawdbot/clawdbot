import fs from "node:fs";
import path from "node:path";

function copyExecutable(source: string, target: string): void {
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o700);
}

/** Builds a user-owned Node layout whose executable and relative libnode path are both trusted. */
export function createTrustedNodeFixture(directory: string): string {
  const runtimeRoot = path.join(directory, "node-runtime");
  const binDir = path.join(runtimeRoot, "bin");
  const target = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
  if (fs.existsSync(target)) {
    return fs.realpathSync(target);
  }
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  copyExecutable(process.execPath, target);

  const sourceLibDir = path.resolve(path.dirname(process.execPath), "..", "lib");
  if (fs.existsSync(sourceLibDir)) {
    const libDir = path.join(runtimeRoot, "lib");
    for (const name of fs.readdirSync(sourceLibDir).filter((entry) => /^libnode[.]/u.test(entry))) {
      fs.mkdirSync(libDir, { recursive: true, mode: 0o700 });
      copyExecutable(fs.realpathSync(path.join(sourceLibDir, name)), path.join(libDir, name));
    }
  }
  return fs.realpathSync(target);
}
