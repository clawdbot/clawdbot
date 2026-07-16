// E2E tests for Docker setup script behavior and generated commands.
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
fail_match="\${DOCKER_STUB_FAIL_MATCH:-}"
docker_host=""
if [[ "\${1:-}" == "--host" ]]; then
  docker_host="\${2:-}"
  shift 2
fi
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  format=""
  if [[ "\${3:-}" == "-f" || "\${3:-}" == "--format" ]]; then
    format="\${4:-}"
    image="\${5:-}"
  else
    image="\${3:-}"
  fi
  echo "image inspect $image host=$docker_host" >>"$log"
  missing_images=",\${DOCKER_STUB_MISSING_IMAGES:-},"
  if [[ "$missing_images" == *",$image,"* ]]; then
    exit 1
  fi
  if [[ -n "$format" ]]; then
    printf '%s\n' "\${DOCKER_STUB_BROWSER_CONTRACT:-<no value>}"
  fi
  exit 0
fi
if [[ "\${1:-}" == "pull" ]]; then
  echo "pull $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "build-fail $*" >>"$log"
    exit 1
  fi
  echo "build DOCKER_BUILDKIT=\${DOCKER_BUILDKIT:-} $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "compose-fail $*" >>"$log"
    exit 1
  fi
  echo "compose $*" >>"$log"
  if [[ "$*" == *"config get tools.sandbox.tools --json"* ]]; then
    if [[ -n "\${DOCKER_STUB_SANDBOX_TOOLS_JSON:-}" ]]; then
      printf '%s\n' "$DOCKER_STUB_SANDBOX_TOOLS_JSON"
    else
      printf '{}\n'
    fi
    exit 0
  fi
  if [[ "$*" == *"config get agents --json"* ]]; then
    if [[ -n "\${DOCKER_STUB_AGENTS_JSON:-}" ]]; then
      printf '%s\n' "$DOCKER_STUB_AGENTS_JSON"
    else
      printf '{}\n'
    fi
    exit 0
  fi
  args=("$@")
  for ((i = 0; i + 4 < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--entrypoint" &&
      "\${args[$((i + 1))]}" == "node" &&
      "\${args[$((i + 2))]}" == "openclaw-gateway" &&
      "\${args[$((i + 3))]}" == "-e" ]]; then
      node -e "\${args[$((i + 4))]}" "\${args[@]:$((i + 5))}"
      exit $?
    fi
  done
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --kill-after=* ]]; then
  shift
elif [[ "\${1:-}" == "--kill-after" ]]; then
  shift 2
fi
if [[ $# -gt 0 ]]; then
  shift
fi
exec "$@"
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(join(binDir, "timeout"), timeoutStub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function expectMissingPath(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${path}`);
}

async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const rootDir = await sandboxRootTracker.make("suite");
  const scriptPath = join(rootDir, "scripts", "docker", "setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await mkdir(join(rootDir, "scripts", "lib"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "setup.sh"), scriptPath);
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-build.sh"),
    join(rootDir, "scripts", "lib", "docker-build.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "build-metadata.sh"),
    join(rootDir, "scripts", "lib", "build-metadata.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-e2e-logs.sh"),
    join(rootDir, "scripts", "lib", "docker-e2e-logs.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-e2e-container.sh"),
    join(rootDir, "scripts", "lib", "docker-e2e-container.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "host-timeout.sh"),
    join(rootDir, "scripts", "lib", "host-timeout.sh"),
  );
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

const sandboxRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-docker-setup-" });

const prestartContainerEnvFlags = [
  "-e HOME=/home/node",
  "-e OPENCLAW_HOME=/home/node",
  "-e OPENCLAW_STATE_DIR=/home/node/.openclaw",
  "-e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
  "-e OPENCLAW_CONFIG_DIR=/home/node/.openclaw",
  "-e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace",
].join(" ");

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    DOCKER_STUB_LOG: sandbox.logPath,
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_WORKSPACE_DIR: join(sandbox.rootDir, "openclaw"),
    OPENCLAW_AUTH_PROFILE_SECRET_DIR: join(sandbox.rootDir, "auth-profile-secrets"),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireSandbox(sandbox: DockerSetupSandbox | null): DockerSetupSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

function runDockerSetup(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
  args: string[] = [],
) {
  return spawnSync("bash", [sandbox.scriptPath, ...args], {
    cwd: sandbox.rootDir,
    env: createEnv(sandbox, overrides),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function resetDockerLog(sandbox: DockerSetupSandbox) {
  await writeFile(sandbox.logPath, "");
}

async function readDockerLog(sandbox: DockerSetupSandbox) {
  return readFile(sandbox.logPath, "utf8");
}

async function readDockerLogLines(sandbox: DockerSetupSandbox) {
  const lines: string[] = [];
  for (const line of (await readDockerLog(sandbox)).split("\n")) {
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

function collectMatchingLines(lines: string[], predicate: (line: string) => boolean): string[] {
  const matches: string[] = [];
  for (const line of lines) {
    if (predicate(line)) {
      matches.push(line);
    }
  }
  return matches;
}

function isGatewayStartLine(line: string) {
  return line.includes("compose") && line.includes(" up -d") && line.includes("openclaw-gateway");
}

function findGatewayStartLineIndex(lines: string[]) {
  return lines.findIndex((line) => isGatewayStartLine(line));
}

function expectOfflineComposePolicy(lines: string[], options: { gatewayStarts?: boolean } = {}) {
  const composeLines = collectMatchingLines(lines, (line) => line.startsWith("compose "));
  expect(composeLines.length).toBeGreaterThan(0);
  for (const line of composeLines) {
    if (line.includes(" run ")) {
      expect(line).toContain(" run --pull never ");
    }
  }
  const gatewayStarts = collectMatchingLines(composeLines, (line) => isGatewayStartLine(line));
  if (options.gatewayStarts === false) {
    expect(gatewayStarts).toHaveLength(0);
    return;
  }
  expect(gatewayStarts.length).toBeGreaterThan(0);
  for (const line of gatewayStarts) {
    expect(line).toContain(" up -d --pull never --no-build");
  }
}

async function runDockerSetupWithUnsetGatewayToken(
  sandbox: DockerSetupSandbox,
  suffix: string,
  prepare?: (configDir: string) => Promise<void>,
) {
  const configDir = join(sandbox.rootDir, `config-${suffix}`);
  const workspaceDir = join(sandbox.rootDir, `workspace-${suffix}`);
  await mkdir(configDir, { recursive: true });
  await prepare?.(configDir);

  const result = runDockerSetup(sandbox, {
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
  });
  const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");

  return { result, envFile };
}

async function withUnixSocket<T>(socketPath: string, run: () => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolveValue, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveValue();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  try {
    return await run();
  } finally {
    await new Promise<void>((resolveLocal) => {
      server.close(() => resolveLocal());
    });
    await rm(socketPath, { force: true });
  }
}

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

describe("scripts/docker/setup.sh", () => {
  let sandbox: DockerSetupSandbox | null = null;

  beforeAll(async () => {
    await sandboxRootTracker.setup();
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      await sandboxRootTracker.cleanup();
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    await sandboxRootTracker.cleanup();
    sandbox = null;
  });

  it("handles env defaults, home-volume mounts, and Docker build args", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const buildCommit = "0123456789abcdef0123456789abcdef01234567";

    const result = runDockerSetup(activeSandbox, {
      GIT_COMMIT: buildCommit,
      OPENCLAW_DOCKER_APT_PACKAGES: "curl wget",
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_IMAGE_APT_PACKAGES=curl wget");
    expect(envFile).toContain("OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=--max-old-space-size=8192");
    expect(envFile).toContain("OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=");
    expect(envFile).toContain("OPENCLAW_DOCKER_BUILD_SKIP_DTS=1");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=openclaw-home"); // pragma: allowlist secret
    expect(envFile).toContain("OPENCLAW_DISABLE_BONJOUR=");
    expect(envFile).toContain(
      `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${join(activeSandbox.rootDir, "auth-profile-secrets")}`,
    );
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("openclaw-home:/home/node");
    expect(extraCompose).toContain(
      `${join(activeSandbox.rootDir, "auth-profile-secrets")}:/home/node/.config/openclaw`,
    );
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("openclaw-home:");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_IMAGE_APT_PACKAGES=curl wget");
    expect(log).toContain(
      "--build-arg OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=--max-old-space-size=8192",
    );
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_BUILD_SKIP_DTS=1");
    expect(log).toMatch(
      /--build-arg OPENCLAW_BUILD_TIMESTAMP=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u,
    );
    expect(log).toContain(`--build-arg GIT_COMMIT=${buildCommit}`);
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js onboard --mode local --no-install-daemon --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --skip-ui --suppress-gateway-token-output`,
    );
    expect(result.stdout).toContain("Gateway token: stored in Docker environment/config");
    expect(result.stdout).toContain("Gateway running with host port mapping.");
    expect(result.stdout).toContain("Access from tailnet devices via the host's tailnet IP.");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("logs -f openclaw-gateway");
    expect(result.stdout).not.toContain("test-token");
    expect(result.stdout).not.toContain("#token=");
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set --batch-json [{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]`,
    );
    expect(log).not.toContain("run --rm openclaw-cli onboard --mode local --no-install-daemon");
  });

  it("allows ordinary spaces in host persistence paths and quotes generated mounts", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config with spaces");
    const workspaceDir = join(activeSandbox.rootDir, "workspace with spaces");
    const authProfileSecretDir = join(activeSandbox.rootDir, "auth secrets with spaces");
    const homeVolumeDir = join(activeSandbox.rootDir, "home volume with spaces");
    const extraMountSource = join(activeSandbox.rootDir, "extra data");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_AUTH_PROFILE_SECRET_DIR: authProfileSecretDir,
      OPENCLAW_HOME_VOLUME: homeVolumeDir,
      OPENCLAW_EXTRA_MOUNTS: `${extraMountSource}:/mnt/extra data:ro`,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("cannot contain whitespace");
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain(`OPENCLAW_CONFIG_DIR=${configDir}`);
    expect(envFile).toContain(`OPENCLAW_WORKSPACE_DIR=${workspaceDir}`);
    expect(envFile).toContain(`OPENCLAW_AUTH_PROFILE_SECRET_DIR=${authProfileSecretDir}`);

    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain(`"${homeVolumeDir}:/home/node"`);
    expect(extraCompose).toContain(`"${configDir}:/home/node/.openclaw"`);
    expect(extraCompose).toContain(`"${workspaceDir}:/home/node/.openclaw/workspace"`);
    expect(extraCompose).toContain(`"${authProfileSecretDir}:/home/node/.config/openclaw"`);
    expect(extraCompose).toContain(`"${extraMountSource}:/mnt/extra data:ro"`);
  });

  it("persists explicit Docker Bonjour opt-in overrides", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_DISABLE_BONJOUR: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DISABLE_BONJOUR=0");
  });

  it("normalizes legacy OPENCLAW_DOCKER_APT_PACKAGES into OPENCLAW_IMAGE_APT_PACKAGES", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "curl wget",
    });
    expect(result.status).toBe(0);

    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_IMAGE_APT_PACKAGES=curl wget");
    expect(envFile).not.toContain("OPENCLAW_DOCKER_APT_PACKAGES");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_IMAGE_APT_PACKAGES=curl wget");
    expect(log).not.toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES");
  });

  it("prefers OPENCLAW_IMAGE_APT_PACKAGES over legacy OPENCLAW_DOCKER_APT_PACKAGES", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_IMAGE_APT_PACKAGES: "curl wget httpie",
      OPENCLAW_DOCKER_APT_PACKAGES: "curl wget",
    });
    expect(result.status).toBe(0);

    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_IMAGE_APT_PACKAGES=curl wget httpie");
    expect(envFile).not.toContain("OPENCLAW_DOCKER_APT_PACKAGES");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_IMAGE_APT_PACKAGES=curl wget httpie");
    expect(log).not.toMatch(/--build-arg OPENCLAW_IMAGE_APT_PACKAGES=curl wget(?! httpie)/);
  });

  it("explicitly empty OPENCLAW_IMAGE_APT_PACKAGES suppresses legacy fallback", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_IMAGE_APT_PACKAGES: "",
      OPENCLAW_DOCKER_APT_PACKAGES: "curl wget",
    });
    expect(result.status).toBe(0);

    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_IMAGE_APT_PACKAGES=");
    expect(envFile).not.toContain("curl wget");

    const log = await readDockerLog(activeSandbox);
    expect(log).not.toContain("--build-arg OPENCLAW_IMAGE_APT_PACKAGES=curl wget");
  });

  it("avoids shared-network openclaw-cli before the gateway is started", async () => {
    const activeSandbox = requireSandbox(sandbox);

    await resetDockerLog(activeSandbox);
    const result = runDockerSetup(activeSandbox);
    expect(result.status).toBe(0);

    const lines = await readDockerLogLines(activeSandbox);
    const gatewayStartIdx = findGatewayStartLineIndex(lines);
    expect(gatewayStartIdx).toBeGreaterThanOrEqual(0);

    const prestartLines = lines.slice(0, gatewayStartIdx);
    const prestartCliRunLines = collectMatchingLines(prestartLines, (line) =>
      /\bcompose\b.*\brun\b.*\bopenclaw-cli\b/.test(line),
    );
    expect(prestartCliRunLines).toStrictEqual([]);
  });

  it("pins setup-time CLI state paths inside the container", async () => {
    const activeSandbox = requireSandbox(sandbox);

    await resetDockerLog(activeSandbox);
    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_HOME: "/mnt/c/Users/Trevor",
      OPENCLAW_STATE_DIR: "/mnt/c/Users/Trevor/.openclaw",
      OPENCLAW_CONFIG_PATH: "/mnt/c/Users/Trevor/.openclaw/openclaw.json",
      OPENCLAW_SKIP_ONBOARDING: "1",
    });
    expect(result.status).toBe(0);

    const lines = await readDockerLogLines(activeSandbox);
    const gatewayStartIdx = findGatewayStartLineIndex(lines);
    expect(gatewayStartIdx).toBeGreaterThanOrEqual(0);

    const prestartConfigLines = collectMatchingLines(lines.slice(0, gatewayStartIdx), (line) =>
      line.includes(" dist/index.js config "),
    );
    expect(prestartConfigLines.length).toBeGreaterThan(0);
    for (const line of prestartConfigLines) {
      expect(line).toContain(prestartContainerEnvFlags);
      expect(line).not.toContain("/mnt/c");
    }
  });

  it("forces BuildKit for local and sandbox docker builds", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await mkdir(join(activeSandbox.rootDir, "scripts", "docker", "sandbox"), { recursive: true });
    await writeFile(
      join(activeSandbox.rootDir, "scripts", "docker", "sandbox", "Dockerfile"),
      "FROM scratch\n",
    );
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "buildkit.sock");

    await withUnixSocket(socketPath, async () => {
      const result = runDockerSetup(activeSandbox, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_DOCKER_SOCKET: socketPath,
      });

      expect(result.status).toBe(0);
      const buildLines = collectMatchingLines(await readDockerLogLines(activeSandbox), (line) =>
        line.startsWith("build "),
      );
      expect(buildLines.length).toBeGreaterThanOrEqual(2);
      const buildLinesWithoutBuildKit = collectMatchingLines(
        buildLines,
        (line) => !line.includes("DOCKER_BUILDKIT=1"),
      );
      expect(buildLinesWithoutBuildKit).toStrictEqual([]);
    });
  });

  it("offline mode reuses a preloaded local image without build or pull", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(
      activeSandbox,
      {
        OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:latest",
        OPENCLAW_SKIP_ONBOARDING: "1",
      },
      ["--offline"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using preloaded Docker image: ghcr.io/openclaw/openclaw:latest",
    );

    const lines = await readDockerLogLines(activeSandbox);
    const log = lines.join("\n");
    expect(log).toContain("image inspect ghcr.io/openclaw/openclaw:latest");
    expect(log).not.toMatch(/^build /m);
    expect(log).not.toMatch(/^pull /m);
    expect(log).toContain("config set --batch-json");
    expectOfflineComposePolicy(lines);
  });

  it("offline mode fails before setup when the main image is missing", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(
      activeSandbox,
      {
        OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:offline",
        DOCKER_STUB_MISSING_IMAGES: "ghcr.io/openclaw/openclaw:offline",
      },
      ["--offline"],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Offline Docker setup requires preloaded image ghcr.io/openclaw/openclaw:offline",
    );

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("image inspect ghcr.io/openclaw/openclaw:offline");
    expect(log).not.toMatch(/^build /m);
    expect(log).not.toMatch(/^pull /m);
    expect(log).not.toContain("up -d openclaw-gateway");
  });

  it("offline sandbox stays disabled when its configured image is missing", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await mkdir(join(activeSandbox.rootDir, "scripts", "docker", "sandbox"), { recursive: true });
    await writeFile(
      join(activeSandbox.rootDir, "scripts", "docker", "sandbox", "Dockerfile"),
      "FROM scratch\n",
    );
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "sb.sock");

    await withUnixSocket(socketPath, async () => {
      const defaultImage = "registry.example/openclaw-sandbox:approved";
      const agentImage = " registry.example/openclaw-sandbox:agent ";
      const result = runDockerSetup(
        activeSandbox,
        {
          OPENCLAW_SANDBOX: "1",
          OPENCLAW_SKIP_ONBOARDING: "1",
          OPENCLAW_DOCKER_SOCKET: socketPath,
          DOCKER_STUB_AGENTS_JSON: JSON.stringify({
            defaults: { sandbox: { docker: { image: defaultImage } } },
            list: [{ id: "custom", sandbox: { docker: { image: agentImage } } }],
          }),
          DOCKER_STUB_MISSING_IMAGES: agentImage,
        },
        ["--offline"],
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot use required sandbox images");
      expect(result.stderr).toContain(agentImage);
      expect(result.stderr).toContain(
        "Offline sandbox prerequisites are incomplete; sandbox configuration was not changed",
      );

      const lines = await readDockerLogLines(activeSandbox);
      const log = lines.join("\n");
      expect(log).toContain("image inspect openclaw:local");
      expect(log).not.toContain(`image inspect ${defaultImage}`);
      expect(log).toContain(`image inspect ${agentImage} host=unix://${socketPath}`);
      expect(log).not.toContain("image inspect openclaw-sandbox:bookworm-slim");
      expect(log).not.toMatch(/^build /m);
      expect(log).not.toMatch(/^pull /m);
      expect(log).not.toContain("config set agents.defaults.sandbox.mode off");
      expect(log).not.toContain("config set agents.defaults.sandbox.mode non-main");
      expectOfflineComposePolicy(lines, { gatewayStarts: false });
    });
  });

  it("offline sandbox validates only effective Docker and browser images", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "eff.sock");

    await withUnixSocket(socketPath, async () => {
      const defaultImage = "registry.example/openclaw-sandbox:default";
      const browserImage = "registry.example/openclaw-sandbox-browser:default";
      const ignoredImages = [
        "registry.example/openclaw-sandbox:ssh",
        "registry.example/openclaw-sandbox:shared-agent",
        "registry.example/openclaw-sandbox-browser:shared-agent",
        "registry.example/openclaw-sandbox:off",
        "registry.example/openclaw-sandbox-browser:denied",
      ];
      const result = runDockerSetup(
        activeSandbox,
        {
          OPENCLAW_SANDBOX: "1",
          OPENCLAW_SKIP_ONBOARDING: "1",
          OPENCLAW_DOCKER_SOCKET: socketPath,
          DOCKER_STUB_AGENTS_JSON: JSON.stringify({
            defaults: {
              sandbox: {
                backend: "Docker",
                docker: { image: defaultImage },
                browser: { enabled: true, image: browserImage },
              },
            },
            list: [
              { id: "ssh", sandbox: { backend: "ssh", docker: { image: ignoredImages[0] } } },
              {
                id: "shared",
                sandbox: {
                  scope: "shared",
                  docker: { image: ignoredImages[1] },
                  browser: { image: ignoredImages[2] },
                },
              },
              { id: "off", sandbox: { mode: "off", docker: { image: ignoredImages[3] } } },
              {
                id: "browser-denied",
                sandbox: { browser: { enabled: true, image: ignoredImages[4] } },
                tools: { sandbox: { tools: { deny: ["browser"] } } },
              },
            ],
          }),
          DOCKER_STUB_SANDBOX_TOOLS_JSON: JSON.stringify({ alsoAllow: ["group:ui"] }),
          DOCKER_STUB_BROWSER_CONTRACT: "2026-05-12-cdp-relay-auth",
          DOCKER_STUB_MISSING_IMAGES: ignoredImages.join(","),
        },
        ["--offline"],
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`  - ${defaultImage}`);
      expect(result.stdout).toContain(`  - ${browserImage}`);

      const lines = await readDockerLogLines(activeSandbox);
      const log = lines.join("\n");
      expect(log).toContain(`image inspect ${defaultImage} host=unix://${socketPath}`);
      expect(log).toContain(`image inspect ${browserImage} host=unix://${socketPath}`);
      for (const image of ignoredImages) {
        expect(log).not.toContain(`image inspect ${image}`);
      }
      expect(log).toContain("config set agents.defaults.sandbox.mode non-main");
      expectOfflineComposePolicy(lines);
    });
  });

  it("offline sandbox rejects an incompatible browser image", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "br.sock");

    await withUnixSocket(socketPath, async () => {
      const browserImage = "registry.example/openclaw-sandbox-browser:stale";
      const result = runDockerSetup(
        activeSandbox,
        {
          OPENCLAW_SANDBOX: "1",
          OPENCLAW_SKIP_ONBOARDING: "1",
          OPENCLAW_DOCKER_SOCKET: socketPath,
          DOCKER_STUB_AGENTS_JSON: JSON.stringify({
            defaults: { sandbox: { browser: { enabled: true, image: browserImage } } },
          }),
          DOCKER_STUB_SANDBOX_TOOLS_JSON: JSON.stringify({ alsoAllow: ["browser"] }),
          DOCKER_STUB_BROWSER_CONTRACT: "old-contract",
        },
        ["--offline"],
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `${browserImage} (browser contract=old-contract, expected=2026-05-12-cdp-relay-auth)`,
      );
      expect(result.stderr).toContain(
        "Offline sandbox prerequisites are incomplete; sandbox configuration was not changed",
      );

      const lines = await readDockerLogLines(activeSandbox);
      const log = lines.join("\n");
      expect(log).toContain(`image inspect ${browserImage} host=unix://${socketPath}`);
      expect(log).not.toContain("config set agents.defaults.sandbox.mode off");
      expect(log).not.toContain("config set agents.defaults.sandbox.mode non-main");
      expectOfflineComposePolicy(lines, { gatewayStarts: false });
    });
  });

  it("precreates config identity dir for CLI device auth writes", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-identity");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-identity");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const identityDirStat = await stat(join(configDir, "identity"));
    expect(identityDirStat.isDirectory()).toBe(true);
  });

  it("writes OPENCLAW_TZ into .env when given a real IANA timezone", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Asia/Shanghai",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_TZ=Asia/Shanghai");
  });

  it("precreates agent data dirs to avoid EACCES in container", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-agent-dirs");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-agent-dirs");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const agentDirStat = await stat(join(configDir, "agents", "main", "agent"));
    expect(agentDirStat.isDirectory()).toBe(true);
    const sessionsDirStat = await stat(join(configDir, "agents", "main", "sessions"));
    expect(sessionsDirStat.isDirectory()).toBe(true);

    // Verify that a root-user chown step runs before setup.
    const log = await readDockerLog(activeSandbox);
    const chownIdx = log.indexOf("--user root");
    const onboardIdx = log.indexOf("onboard");
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(onboardIdx).toBeGreaterThan(chownIdx);
    expect(log).toContain("run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c");
    expect(log).toContain("chown node:node /home/node/.config");
  });

  it("precreates auth profile secret key dir outside the mounted state dir", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-auth-profile-key");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-auth-profile-key");
    const secretDir = join(activeSandbox.rootDir, "auth-profile-secret-key");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_AUTH_PROFILE_SECRET_DIR: secretDir,
    });

    expect(result.status).toBe(0);
    const secretDirStat = await stat(secretDir);
    expect(secretDirStat.isDirectory()).toBe(true);
    expect(secretDir.startsWith(`${configDir}/`)).toBe(false);

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("find /home/node/.config/openclaw -xdev");
  });

  it("reuses existing config token when OPENCLAW_GATEWAY_TOKEN is unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "token-reuse",
      async (configDir) => {
        await writeFile(
          join(configDir, "openclaw.json"),
          JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token-123" } } }),
        );
      },
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=config-token-123"); // pragma: allowlist secret
  });

  it("reuses existing .env token when OPENCLAW_GATEWAY_TOKEN and config token are unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=dotenv-token-123\nOPENCLAW_GATEWAY_PORT=18789\n", // pragma: allowlist secret
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-token-reuse",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=dotenv-token-123"); // pragma: allowlist secret
    expect(result.stderr).toBe("");
  });

  it("reuses the last non-empty .env token and strips CRLF without truncating '='", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      [
        "OPENCLAW_GATEWAY_TOKEN=",
        "OPENCLAW_GATEWAY_TOKEN=first-token",
        "OPENCLAW_GATEWAY_TOKEN=last=token=value\r", // pragma: allowlist secret
      ].join("\n"),
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-last-wins",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=last=token=value"); // pragma: allowlist secret
    expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN=first-token");
    expect(envFile).not.toContain("\r");
  });

  it("treats OPENCLAW_SANDBOX=0 as disabled", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_SANDBOX=");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=");
    expect(log).not.toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=1");
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
  });

  it("resets stale sandbox mode and overlay when sandbox is not active", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    await writeFile(
      join(activeSandbox.rootDir, "docker-compose.sandbox.yml"),
      "services:\n  openclaw-gateway:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );
    const socketPath = join(activeSandbox.rootDir, "missing-cli.sock");

    await withUnixSocket(socketPath, async () => {
      const result = runDockerSetup(activeSandbox, {
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_DOCKER_SOCKET: socketPath,
        DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Sandbox requires Docker CLI");
      const log = await readDockerLog(activeSandbox);
      expect(log).toContain("config set agents.defaults.sandbox.mode off");
      await expectMissingPath(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"));
    });
  });

  it("keeps offline policy when sandbox config writes fail and the gateway rolls back", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "sandbox.sock");

    await withUnixSocket(socketPath, async () => {
      const result = runDockerSetup(
        activeSandbox,
        {
          OPENCLAW_SANDBOX: "1",
          OPENCLAW_DOCKER_SOCKET: socketPath,
          DOCKER_STUB_FAIL_MATCH: "config set agents.defaults.sandbox.scope",
        },
        ["--offline"],
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Failed to set agents.defaults.sandbox.scope");
      expect(result.stderr).toContain("Skipping gateway restart to avoid exposing Docker socket");

      const lines = await readDockerLogLines(activeSandbox);
      const log = lines.join("\n");
      const gatewayStarts = collectMatchingLines(lines, (line) => isGatewayStartLine(line));
      expect(gatewayStarts).toHaveLength(2);
      expect(log).toContain(
        "run --pull never --rm --no-deps openclaw-cli config set agents.defaults.sandbox.mode non-main",
      );
      expect(log).toContain("config set agents.defaults.sandbox.mode off");
      const forceRecreateLine = log
        .split("\n")
        .find((line) => line.includes("--force-recreate openclaw-gateway"));
      expect(forceRecreateLine).toBe(
        `compose compose -f ${join(activeSandbox.rootDir, "docker-compose.yml")} up -d --pull never --no-build --force-recreate openclaw-gateway`,
      );
      expect(forceRecreateLine).not.toContain("docker-compose.sandbox.yml");
      expect(log).toContain(
        `image inspect openclaw-sandbox:bookworm-slim host=unix://${socketPath}`,
      );
      expectOfflineComposePolicy(lines);
      await expectMissingPath(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"));
    });
  });

  it("rejects injected multiline OPENCLAW_EXTRA_MOUNTS values", () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid OPENCLAW_EXTRA_MOUNTS mount format", () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid OPENCLAW_HOME_VOLUME names", () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_HOME_VOLUME must match");
  });

  it("rejects OPENCLAW_TZ values that are not present in zoneinfo", () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Nope/Bad",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_TZ must match a timezone in /usr/share/zoneinfo");
  });

  it("skips onboarding when OPENCLAW_SKIP_ONBOARDING is set", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SKIP_ONBOARDING: "1",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).not.toContain("onboard");
    // Gateway defaults (config set) and control UI allowlist should still run.
    expect(log).toContain("config set --batch-json");
    expect(log).toContain('"path":"gateway.mode","value":"local"');
    expect(log).toContain('"path":"gateway.bind","value":"lan"');
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_SKIP_ONBOARDING=1");
  });

  it("treats OPENCLAW_SKIP_ONBOARDING=0 as disabled and runs onboarding", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SKIP_ONBOARDING: "0",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      "onboard --mode local --no-install-daemon --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --skip-ui --suppress-gateway-token-output",
    );
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toMatch(/OPENCLAW_SKIP_ONBOARDING=\n/);
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "scripts", "docker", "setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);

    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const assocCheck = spawnSync(systemBash, ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status === 0 || assocCheck.status === null) {
      // Skip runtime check when system bash supports associative arrays
      // (not Bash 3.2) or when /bin/bash is unavailable (e.g. Windows).
      return;
    }

    const syntaxCheck = spawnSync(
      systemBash,
      ["-n", join(repoRoot, "scripts", "docker", "setup.sh")],
      {
        encoding: "utf8",
      },
    );

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).not.toContain("declare: -A: invalid option");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("keeps docker-compose gateway Bonjour advertising in auto mode by default", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(
      compose.match(/OPENCLAW_DISABLE_BONJOUR: \$\{OPENCLAW_DISABLE_BONJOUR:-\}/g),
    ).toHaveLength(1);
  });

  it("keeps docker-compose CLI network namespace settings in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('network_mode: "service:openclaw-gateway"');
    expect(compose).toContain("depends_on:\n      - openclaw-gateway");
  });

  it("keeps docker-compose gateway token env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/OPENCLAW_GATEWAY_TOKEN: \$\{OPENCLAW_GATEWAY_TOKEN:-\}/g)).toHaveLength(
      2,
    );
  });

  it("keeps docker-compose auth profile secret key source durable outside state", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(
      compose.split(
        '"${OPENCLAW_AUTH_PROFILE_SECRET_DIR:-${HOME:-/tmp}/.openclaw-auth-profile-secrets}:/home/node/.config/openclaw"',
      ),
    ).toHaveLength(3);
  });

  it("keeps docker-compose optional env files aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/env_file:\n {6}- path: \.env\n {8}required: false/g)).toHaveLength(2);
  });

  it("keeps docker-compose timezone env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/TZ: \$\{OPENCLAW_TZ:-UTC\}/g)).toHaveLength(2);
  });

  it("pins container-side state, workspace, and config dirs on both services so host .env paths cannot leak (#77436)", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    // Both gateway and CLI services must override env_file values with the
    // canonical container paths so host-style paths written to `.env` cannot
    // reach runtime code inside Linux Docker.
    expect(compose.match(/OPENCLAW_HOME: \/home\/node$/gm)).toHaveLength(2);
    expect(compose.match(/OPENCLAW_STATE_DIR: \/home\/node\/\.openclaw$/gm)).toHaveLength(2);
    expect(
      compose.match(/OPENCLAW_CONFIG_PATH: \/home\/node\/\.openclaw\/openclaw\.json$/gm),
    ).toHaveLength(2);
    expect(compose.match(/OPENCLAW_CONFIG_DIR: \/home\/node\/\.openclaw$/gm)).toHaveLength(2);
    expect(
      compose.match(/OPENCLAW_WORKSPACE_DIR: \/home\/node\/\.openclaw\/workspace$/gm),
    ).toHaveLength(2);
  });

  it("Dockerfile ARG OPENCLAW_IMAGE_APT_PACKAGES must not have a default value", async () => {
    // If the ARG has a default (e.g. ARG OPENCLAW_IMAGE_APT_PACKAGES=""), Docker treats it as
    // "set" even when no --build-arg is passed. That breaks the RUN fallback expression
    // ${OPENCLAW_IMAGE_APT_PACKAGES-$OPENCLAW_DOCKER_APT_PACKAGES} because the variable is
    // never truly unset, so legacy-only callers using --build-arg OPENCLAW_DOCKER_APT_PACKAGES
    // get nothing installed — a backward-compat regression.
    const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
    const argLine = dockerfile
      .split("\n")
      .find((line) => line.startsWith("ARG OPENCLAW_IMAGE_APT_PACKAGES"));
    expect(argLine).toBeDefined();
    // Must be bare `ARG OPENCLAW_IMAGE_APT_PACKAGES` with no default assignment
    expect(argLine).toBe("ARG OPENCLAW_IMAGE_APT_PACKAGES");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
