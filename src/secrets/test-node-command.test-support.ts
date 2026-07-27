import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function withSecureTestNodeCommand<T>(
  run: (command: string) => Promise<T>,
): Promise<T> {
  if (process.platform === "win32") {
    return await run(process.execPath);
  }
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-node-"));
  const command = path.join(rootDir, "node");
  try {
    await fs.chmod(rootDir, 0o700);
    await fs.writeFile(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, {
      mode: 0o700,
    });
    return await run(command);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

export async function withSecureTestNodeExecPath<T>(run: () => Promise<T>): Promise<T> {
  return await withSecureTestNodeCommand(async (command) => {
    const original = Object.getOwnPropertyDescriptor(process, "execPath");
    if (!original) {
      throw new Error("process.execPath descriptor is unavailable");
    }
    // Plugin ${node} materialization reads process.execPath directly. Keep that global swap
    // bounded to one awaited test and always restore it before deleting the wrapper.
    Object.defineProperty(process, "execPath", { ...original, value: command });
    try {
      return await run();
    } finally {
      Object.defineProperty(process, "execPath", original);
    }
  });
}
