// Proves the shared-directory topology on the Docker sandbox backend: each agent keeps a
// private workspace no peer can reach, while one shared host directory is read-write for all
// of them. The shared root is admitted by `docker.allowedBindSources` alone, so the
// all-or-nothing external-source override stays unnecessary for this shape.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { ensureSandboxContainer, resolveAllowedBindSourceRoots } from "./docker.js";
import type { SandboxConfig } from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";

const CONTAINER_PREFIX = "openclaw-bindproof-";
// The default sandbox image carries the helpers the sandbox write/edit bridge needs, so this
// runs on the same image real agents get (build: scripts/sandbox-setup.sh).
const IMAGE = DEFAULT_SANDBOX_IMAGE;
const SHARED_MOUNT = "/team";
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function execFileAsync(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

async function dockerReady(): Promise<boolean> {
  const probe = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (probe.code !== 0) {
    return false;
  }
  // ensureDockerImage never pulls on demand, so a missing local image is an environment gap
  // rather than a topology failure.
  const image = await execFileAsync("docker", ["image", "inspect", IMAGE]);
  return image.code === 0;
}

let dockerAvailable = false;
let root = "";
let stateDir = "";
let envSnapshot: { restore: () => void } | undefined;
const containerNames: string[] = [];

type Member = {
  id: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  privateFile: string;
};

const members: Record<"one" | "two", Member> = {
  one: { id: "member-one", workspaceDir: "", agentWorkspaceDir: "", privateFile: "ONE.md" },
  two: { id: "member-two", workspaceDir: "", agentWorkspaceDir: "", privateFile: "TWO.md" },
};

let sharedDir = "";

function buildSandboxConfig(params: { allowedBindSources?: string[] }): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "agent",
    workspaceAccess: "rw",
    workspaceRoot: root,
    dockerTmpfsSource: "configured",
    docker: {
      image: IMAGE,
      containerPrefix: CONTAINER_PREFIX,
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [`${sharedDir}:${SHARED_MOUNT}:rw`],
      ...(params.allowedBindSources ? { allowedBindSources: params.allowedBindSources } : {}),
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "unused",
      containerPrefix: CONTAINER_PREFIX,
      network: "none",
      cdpPort: 0,
      vncPort: 0,
      noVncPort: 0,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 1,
    },
    tools: {},
    prune: { idleHours: 0, maxAgeDays: 0 },
  };
}

async function startMember(member: Member): Promise<string> {
  const name = await ensureSandboxContainer({
    scopeKey: member.id,
    workspaceDir: member.workspaceDir,
    agentWorkspaceDir: member.agentWorkspaceDir,
    cfg: buildSandboxConfig({ allowedBindSources: [sharedDir] }),
  });
  containerNames.push(name);
  return name;
}

async function containerShell(name: string, script: string) {
  return await execFileAsync("docker", ["exec", "-i", name, "/bin/sh", "-lc", script]);
}

beforeAll(async () => {
  dockerAvailable = await dockerReady();
  // macOS os.tmpdir() is a /var -> /private/var symlink; sandbox mount policy compares
  // canonical paths, so the fixture root must already be canonical.
  root = await fs.realpath(tempDirs.make("openclaw-bindproof-"));
  // The sandbox registry writes to the shared state DB. Own that path explicitly so the run
  // cannot reach a real state directory.
  stateDir = path.join(root, "state-root");
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  sharedDir = path.join(root, "shared");
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(sharedDir, "SHARED.md"), "shared notes\n");
  for (const member of Object.values(members)) {
    member.workspaceDir = path.join(root, "private", member.id);
    member.agentWorkspaceDir = path.join(root, "agents", member.id);
    await fs.mkdir(member.workspaceDir, { recursive: true });
    await fs.mkdir(member.agentWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(member.workspaceDir, member.privateFile), `${member.id}\n`);
  }
}, 60_000);

afterAll(async () => {
  for (const name of containerNames) {
    await execFileAsync("docker", ["rm", "-f", name]);
  }
  envSnapshot?.restore();
}, 120_000);

describe("sandbox allowed bind sources", () => {
  function ownRoots() {
    return [members.one.workspaceDir, members.one.agentWorkspaceDir];
  }

  it("blocks a shared bind that no configured root allows", () => {
    const cfg = buildSandboxConfig({});
    expect(() =>
      validateSandboxSecurity({
        ...cfg.docker,
        allowedSourceRoots: resolveAllowedBindSourceRoots(cfg.docker, ownRoots()),
        allowSourcesOutsideAllowedRoots: false,
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("admits the shared bind once its root is allowlisted, with no dangerous override", () => {
    const cfg = buildSandboxConfig({ allowedBindSources: [sharedDir] });
    expect(cfg.docker.dangerouslyAllowExternalBindSources).toBeUndefined();
    expect(() =>
      validateSandboxSecurity({
        ...cfg.docker,
        allowedSourceRoots: resolveAllowedBindSourceRoots(cfg.docker, ownRoots()),
        allowSourcesOutsideAllowedRoots: false,
      }),
    ).not.toThrow();
  });

  it("keeps every non-allowlisted source blocked while an allowlist is in force", () => {
    const cfg = buildSandboxConfig({ allowedBindSources: [sharedDir] });
    expect(() =>
      validateSandboxSecurity({
        ...cfg.docker,
        binds: [`${members.two.workspaceDir}:/peek:rw`],
        allowedSourceRoots: resolveAllowedBindSourceRoots(cfg.docker, ownRoots()),
        allowSourcesOutsideAllowedRoots: false,
      }),
    ).toThrow(/outside allowed roots/);
  });

  it("leaves the gate off when the caller supplies no roots at all", () => {
    const cfg = buildSandboxConfig({ allowedBindSources: [sharedDir] });
    expect(resolveAllowedBindSourceRoots(cfg.docker, undefined)).toBeUndefined();
  });

  it.each(["/", "/srv/..", "C:/", "c:\\shared\\..", "\\\\?\\C:\\"])(
    "rejects configured filesystem root %s at the runtime boundary",
    (configuredRoot) => {
      const cfg = buildSandboxConfig({ allowedBindSources: [configuredRoot] });
      expect(() => resolveAllowedBindSourceRoots(cfg.docker, ownRoots())).toThrow(
        /filesystem root/,
      );
    },
  );

  it("rejects a configured root whose canonical path is the filesystem root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const rootAlias = path.join(root, "filesystem-root-alias");
    await fs.symlink("/", rootAlias, "dir");
    const cfg = buildSandboxConfig({ allowedBindSources: [rootAlias] });
    expect(() => resolveAllowedBindSourceRoots(cfg.docker, ownRoots())).toThrow(
      /resolves to filesystem root/,
    );
  });

  it("gives each agent a private workspace and one shared directory", async (ctx) => {
    if (!dockerAvailable) {
      ctx.skip(`docker daemon or ${IMAGE} unavailable`);
      return;
    }
    const nameOne = await startMember(members.one);
    const nameTwo = await startMember(members.two);
    expect(nameOne).not.toBe(nameTwo);

    // Private: each agent sees only its own file at /workspace.
    const own = await containerShell(nameOne, "cat /workspace/ONE.md");
    expect(own.code).toBe(0);
    expect(own.stdout).toContain(members.one.id);

    const cross = await containerShell(nameOne, "cat /workspace/TWO.md");
    expect(cross.code).not.toBe(0);

    // The peer's host path does not exist in this mount namespace at all.
    const hostPathProbe = await containerShell(
      nameOne,
      `test -e ${JSON.stringify(members.two.workspaceDir)} && echo VISIBLE || echo ABSENT`,
    );
    expect(hostPathProbe.stdout.trim()).toBe("ABSENT");

    // Shared: both agents mount the same host directory read-write.
    const readShared = await containerShell(nameTwo, `cat ${SHARED_MOUNT}/SHARED.md`);
    expect(readShared.code).toBe(0);
    expect(readShared.stdout).toContain("shared notes");

    const write = await containerShell(
      nameOne,
      `printf 'from-one\\n' > ${SHARED_MOUNT}/handoff.md`,
    );
    expect(write.code).toBe(0);
    const readBack = await containerShell(nameTwo, `cat ${SHARED_MOUNT}/handoff.md`);
    expect(readBack.code).toBe(0);
    expect(readBack.stdout).toContain("from-one");

    // The host sees the same file, so the shared directory is one artifact, not a copy.
    await expect(fs.readFile(path.join(sharedDir, "handoff.md"), "utf8")).resolves.toContain(
      "from-one",
    );

    // Mount set is the enforcement boundary: the peer workspace is never a source.
    const inspect = await execFileAsync("docker", ["inspect", "-f", "{{json .Mounts}}", nameOne]);
    expect(inspect.code).toBe(0);
    const sources = (JSON.parse(inspect.stdout) as Array<{ Source: string }>).map(
      (mount) => mount.Source,
    );
    expect(sources).toContain(members.one.workspaceDir);
    expect(sources).toContain(sharedDir);
    expect(sources).not.toContain(members.two.workspaceDir);
    expect(sources.some((source) => source.includes(members.two.id))).toBe(false);

    // Registry rows landed in the test-owned state DB.
    const statePath = resolveOpenClawStateSqlitePath();
    expect(statePath.startsWith(stateDir)).toBe(true);
    await expect(fs.stat(statePath)).resolves.toBeDefined();
  }, 300_000);
});
