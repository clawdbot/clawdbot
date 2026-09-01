import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectCloneFailureCause } from "../../packages/gateway-protocol/src/index.js";
import { runCommandWithTimeout } from "../process/exec.js";

const PROJECT_CLONE_TIMEOUT_MS = 10 * 60_000;

export class ProjectCloneError extends Error {
  constructor(
    readonly failure: ProjectCloneFailureCause,
    message: string,
  ) {
    super(message);
    this.name = "ProjectCloneError";
  }
}

function cloneCommandEnv(token: string | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TEMPLATE_DIR: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_EXTERNAL_DIFF: "",
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSL_NO_VERIFY: undefined,
  };
  if (token) {
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return gitEnv;
}

function classifyCloneFailure(params: {
  output: string;
  tokenConfigured: boolean;
  timedOut?: boolean;
}): ProjectCloneError {
  const detail = params.output.toLowerCase();
  if (
    params.timedOut ||
    /could not resolve host|connection timed out|failed to connect/u.test(detail)
  ) {
    return new ProjectCloneError(
      "network",
      "Git clone could not reach GitHub. Check the Gateway network connection and retry.",
    );
  }
  if (
    /authentication failed|permission denied|could not read username|access denied/u.test(detail)
  ) {
    return new ProjectCloneError(
      "auth_required",
      params.tokenConfigured
        ? "GitHub rejected the active Control UI credential. Update gateway.controlUi.github.token when set; otherwise update the shared Gateway process environment, then retry."
        : "GitHub authentication is required. Configure gateway.controlUi.github.token or set GH_TOKEN/GITHUB_TOKEN in the shared Gateway process environment to clone private repositories.",
    );
  }
  if (/repository not found|not found/u.test(detail)) {
    return params.tokenConfigured
      ? new ProjectCloneError(
          "not_found",
          "GitHub could not find that repository. Check the URL and repository access.",
        )
      : new ProjectCloneError(
          "auth_required",
          "The repository was not found or is private. Check the URL, or configure gateway.controlUi.github.token (or the shared Gateway process environment) for private repositories.",
        );
  }
  return new ProjectCloneError(
    "clone_failed",
    "Git could not clone that repository. Check the URL and Gateway Git configuration, then retry.",
  );
}

/** Clones one already-validated source into an unoccupied managed target. */
export async function cloneProjectCheckout(
  input: { url: string; target: string },
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    token?: string;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const existed = await fs.lstat(input.target).then(
    () => true,
    () => false,
  );
  if (existed) {
    throw new ProjectCloneError(
      "target_exists",
      "A managed checkout already exists for this repository. Register or remove it before retrying.",
    );
  }
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  const result = await runCommandWithTimeout(
    ["git", "clone", "--no-recurse-submodules", "--", input.url, input.target],
    {
      env: cloneCommandEnv(options.token, env),
      timeoutMs: options.timeoutMs ?? PROJECT_CLONE_TIMEOUT_MS,
      signal: options.signal,
      killProcessTree: true,
      maxOutputBytes: 256 * 1024,
    },
  );
  if (result.code === 0 && result.termination === "exit") {
    return;
  }
  await fs.rm(input.target, { recursive: true, force: true }).catch(() => {});
  throw classifyCloneFailure({
    output: `${result.stderr}\n${result.stdout}`,
    tokenConfigured: Boolean(options.token),
    timedOut: result.termination === "timeout" || result.termination === "no-output-timeout",
  });
}
