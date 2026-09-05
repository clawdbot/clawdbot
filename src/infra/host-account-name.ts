import fs from "node:fs/promises";
import os from "node:os";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runExec } from "../process/exec.js";

// Account metadata is process-stable. Cache failures too so reconnects never repeat OS lookups.
let cachedName: Promise<string | null> | undefined;

async function readAccountCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runExec(command, args, {
      timeoutMs: 1000,
      maxBuffer: 16 * 1024,
      logOutput: false,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function readHostAccountName(): Promise<string | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  const { username } = os.userInfo();
  const normalizeName = (value: string | null | undefined) => {
    const name = value?.trim();
    // Service accounts often repeat the login in their full-name field.
    return name && name.toLowerCase() !== username.toLowerCase()
      ? truncateUtf16Safe(name, 256)
      : null;
  };
  if (process.platform === "darwin") {
    const fullName = normalizeName(await readAccountCommand("/usr/bin/id", ["-F"]));
    if (fullName) {
      return fullName;
    }
    const record = await readAccountCommand("/usr/bin/dscl", [
      ".",
      "-read",
      `/Users/${username}`,
      "RealName",
    ]);
    return normalizeName(record?.replace(/^RealName:\s*/u, ""));
  }
  const record =
    (await readAccountCommand("getent", ["passwd", username])) ??
    (await fs.readFile("/etc/passwd", "utf8"));
  const fields = record
    .split("\n")
    .find((line) => line.split(":", 1)[0] === username)
    ?.split(":");
  return normalizeName(fields?.[4]?.split(",", 1)[0]);
}

/** Best-effort human name for the gateway host account; never seeds a login name. */
export function resolveHostAccountName(): Promise<string | null> {
  cachedName ??= readHostAccountName().catch(() => null);
  return cachedName;
}
