// Owns private, short-lived environment transport for Docker and Podman commands.
import { normalizeEnvVarKey } from "./host-env-security.js";
import { tempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type ContainerEnvFile = {
  path: string;
  cleanup: () => Promise<void>;
};

export function getContainerEnvFileEntryIssue(
  key: string,
  value: string,
): "invalid-name" | "line-break" | "nul" | undefined {
  if (normalizeEnvVarKey(key, { portable: true }) !== key) {
    return "invalid-name";
  }
  if (/[\r\n]/u.test(value)) {
    return "line-break";
  }
  return value.includes("\0") ? "nul" : undefined;
}

function serializeContainerEnv(env: Readonly<Record<string, string>>): string {
  let content = "";
  const entries = Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    const issue = getContainerEnvFileEntryIssue(key, value);
    if (issue === "invalid-name") {
      throw new Error(
        `Invalid container environment variable name ${JSON.stringify(key)}; use letters, digits, and underscores without a leading digit.`,
      );
    }
    if (issue === "line-break") {
      throw new Error(
        `Container environment variable ${key} must have a single-line value because Docker and Podman --env-file entries are line-delimited.`,
      );
    }
    if (issue === "nul") {
      throw new Error(`Container environment variable ${key} must not contain NUL bytes.`);
    }
    content += `${key}=${value}\n`;
  }
  return content;
}

/** Stages engine environment values outside process arguments until the caller-owned cleanup. */
export async function createContainerEnvFile(
  env: Readonly<Record<string, string>>,
): Promise<ContainerEnvFile> {
  const content = serializeContainerEnv(env);
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-container-env-",
    dirMode: 0o700,
    mode: 0o600,
  });

  try {
    const filePath = await workspace.write("container.env", content);
    return {
      path: filePath,
      cleanup: async () => {
        await workspace.cleanup();
      },
    };
  } catch (error) {
    await workspace.cleanup().catch(() => undefined);
    throw error;
  }
}

/** Keeps a private container environment file alive only while its engine operation runs. */
export async function withContainerEnvFile<T>(
  env: Readonly<Record<string, string>>,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  const file = await createContainerEnvFile(env);
  try {
    return await run(file.path);
  } finally {
    await file.cleanup();
  }
}
