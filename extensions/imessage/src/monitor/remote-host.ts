import fs from "node:fs/promises";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { expandIMessageUserPath } from "../cli-path.js";

export async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(expandIMessageUserPath(cliPath), "utf8");
    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logVerbose(
        `imessage: failed to inspect cliPath ${cliPath} for remoteHost detection: ${String(err)}`,
      );
    }
    return undefined;
  }
}
