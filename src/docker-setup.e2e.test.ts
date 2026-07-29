// E2E tests for Docker setup script behavior and generated commands.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupDockerSetupSandboxRoot,
  collectMatchingLines,
  createDockerSetupSandbox,
  expectMissingPath,
  expectOfflineComposePolicy,
  findGatewayStartLineIndex,
  isGatewayStartLine,
  noFollowOwnershipRepair,
  prestartContainerEnvFlags,
  prestartSafePath,
  readDockerLog,
  readDockerLogLines,
  repoRoot,
  requireSandbox,
  resetDockerLog,
  resolveBashForCompatCheck,
  setupDockerSetupSandboxRoot,
  withUnixSocket,
  type DockerSetupSandbox,
} from "./docker-setup.e2e.test-support.js";

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

describe("scripts/docker/setup.sh", () => {
  let sandbox: DockerSetupSandbox | null = null;

  beforeAll(async () => {
    await setupDockerSetupSandboxRoot();
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      await cleanupDockerSetupSandboxRoot();
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    await cleanupDockerSetupSandboxRoot();
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
    const safePathIdx = log.indexOf(`${prestartSafePath}; export PATH`);
    const stateRepairIdx = log.indexOf(noFollowOwnershipRepair("/home/node/.openclaw"));
    const onboardIdx = log.indexOf("onboard");
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(safePathIdx).toBeGreaterThan(chownIdx);
    expect(stateRepairIdx).toBeGreaterThan(safePathIdx);
    expect(onboardIdx).toBeGreaterThan(chownIdx);
    expect(log).toContain("run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c");
    expect(log).toContain("/usr/bin/chown -h node:node /home/node/.config");
    expect(log).toContain(noFollowOwnershipRepair("/home/node/.openclaw"));
    expect(log).toContain(noFollowOwnershipRepair("/home/node/.config/openclaw"));
    expect(log).toContain("[ ! -L /home/node/.openclaw/workspace/.openclaw ]");
    expect(log).toContain(noFollowOwnershipRepair("/home/node/.openclaw/workspace/.openclaw"));
    expect(log).toContain("fi || true");
    expect(log).not.toContain("-type d -o -type f");
    expect(log).not.toContain("-exec chown");
    expect(log).not.toContain(" chown node:node");
    expect(log).not.toContain("chown -R node:node /home/node/.openclaw/workspace/.openclaw");
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
    expect(log).toContain(noFollowOwnershipRepair("/home/node/.config/openclaw"));
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
