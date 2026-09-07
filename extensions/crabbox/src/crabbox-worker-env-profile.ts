import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export async function withCrabboxWorkerEnvProfile<Result>(
  values: Record<string, string> | undefined,
  run: (names: string[], path: string | undefined, childEnv: NodeJS.ProcessEnv) => Promise<Result>,
): Promise<Result> {
  const entries = Object.entries(values ?? {});
  const names = entries.map(([name]) => name);
  let directory: string | undefined;
  try {
    let profilePath: string | undefined;
    if (entries.length > 0) {
      const profile = entries
        .map(([name, value]) => {
          if (["\0", "\r", "\n", "`", "$("].some((unsafe) => value.includes(unsafe))) {
            throw new WorkerProviderError(
              `Crabbox setup environment value cannot be represented safely: ${name}`,
            );
          }
          return `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
        })
        .join("\n");
      directory = await mkdtemp(join(resolvePreferredOpenClawTmpDir(), "openclaw-crabbox-env-"));
      profilePath = join(directory, "setup.env");
      await writeFile(profilePath, `${profile}\n`, { mode: 0o600, flag: "wx" });
    }
    // Explicit deletion prevents profile-backed secrets from leaking through inherited SSH argv.
    return await run(names, profilePath, {
      ...Object.fromEntries(names.map((name) => [name, undefined])),
      CRABBOX_ENV_ALLOW: ",",
    });
  } finally {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
  }
}
