// Sandbox config hash tests pin which runtime settings require container
// recreation versus reuse.
import { describe, expect, it } from "vitest";
import { computeSandboxBrowserConfigHash, computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import type { SandboxDockerConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

function createDockerConfig(overrides?: Partial<SandboxDockerConfig>): SandboxDockerConfig {
  return {
    image: "openclaw-sandbox:test",
    containerPrefix: "openclaw-sbx-",
    workdir: "/workspace",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    network: "none",
    capDrop: ["ALL"],
    env: { LANG: "C.UTF-8" },
    dns: ["1.1.1.1", "8.8.8.8"],
    extraHosts: ["host.docker.internal:host-gateway"],
    binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
    ...overrides,
  };
}

type DockerArrayField = "tmpfs" | "capDrop" | "dns" | "extraHosts" | "binds";

const ORDER_SENSITIVE_ARRAY_CASES: ReadonlyArray<{
  field: DockerArrayField;
  before: string[];
  after: string[];
}> = [
  {
    field: "tmpfs",
    before: ["/tmp", "/var/tmp", "/run"],
    after: ["/run", "/var/tmp", "/tmp"],
  },
  {
    field: "capDrop",
    before: ["ALL", "CHOWN"],
    after: ["CHOWN", "ALL"],
  },
  {
    field: "dns",
    before: ["1.1.1.1", "8.8.8.8"],
    after: ["8.8.8.8", "1.1.1.1"],
  },
  {
    field: "extraHosts",
    before: ["host.docker.internal:host-gateway", "db.local:10.0.0.5"],
    after: ["db.local:10.0.0.5", "host.docker.internal:host-gateway"],
  },
  {
    field: "binds",
    before: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
    after: ["/tmp/cache:/cache:ro", "/tmp/workspace:/workspace:rw"],
  },
];

describe("computeSandboxConfigHash", () => {
  it("ignores object key order", () => {
    const shared = {
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          LANG: "C.UTF-8",
          B: "2",
          A: "1",
        },
      }),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        env: {
          A: "1",
          B: "2",
          LANG: "C.UTF-8",
        },
      }),
    });
    expect(left).toBe(right);
  });

  it.each(ORDER_SENSITIVE_ARRAY_CASES)("treats $field order as significant", (testCase) => {
    // Docker arrays are command-line arguments; reordering can change runtime
    // behavior and must invalidate an existing sandbox.
    const shared = {
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        [testCase.field]: testCase.before,
      } as Partial<SandboxDockerConfig>),
    });
    const right = computeSandboxConfigHash({
      ...shared,
      docker: createDockerConfig({
        [testCase.field]: testCase.after,
      } as Partial<SandboxDockerConfig>),
    });
    expect(left).not.toBe(right);
  });

  it("changes when the shared Docker create-args epoch changes", () => {
    const shared = {
      docker: createDockerConfig(),
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    };
    const left = computeSandboxConfigHash({ ...shared, createArgsEpoch: "epoch-v1" });
    const right = computeSandboxConfigHash({ ...shared, createArgsEpoch: "epoch-v2" });
    expect(left).not.toBe(right);
  });

  it("changes when read-only workspace skill mount state changes", () => {
    // Skill overlays affect what the sandbox can read, so they are part of the
    // reuse identity even though they are read-only.
    const shared = {
      docker: createDockerConfig(),
      dockerEnvPolicyEpoch: undefined,
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };

    const withoutSkills = computeSandboxConfigHash({
      ...shared,
      readOnlyWorkspaceSkillMounts: [],
    });

    const withSkills = computeSandboxConfigHash({
      ...shared,
      readOnlyWorkspaceSkillMounts: ["/tmp/workspace/skills:/workspace/skills:ro"],
    });

    expect(withoutSkills).not.toBe(withSkills);
  });
});

describe("computeSandboxBrowserConfigHash", () => {
  it("treats docker bind order as significant", () => {
    const shared = {
      browser: {
        cdpPort: 9222,
        cdpSourceRange: undefined,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        autoStartTimeoutMs: 12000,
      },
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/workspace:/workspace:rw", "/tmp/cache:/cache:ro"],
      }),
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      docker: createDockerConfig({
        binds: ["/tmp/cache:/cache:ro", "/tmp/workspace:/workspace:rw"],
      }),
    });
    expect(left).not.toBe(right);
  });

  it("changes when the shared Docker create-args epoch changes", () => {
    const shared = {
      docker: createDockerConfig(),
      browser: {
        cdpPort: 9222,
        cdpSourceRange: undefined,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        autoStartTimeoutMs: 12000,
      },
      securityEpoch: "browser-security-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    };
    const left = computeSandboxBrowserConfigHash({ ...shared, createArgsEpoch: "epoch-v1" });
    const right = computeSandboxBrowserConfigHash({ ...shared, createArgsEpoch: "epoch-v2" });
    expect(left).not.toBe(right);
  });

  it("changes when security epoch changes", () => {
    const shared = {
      docker: createDockerConfig(),
      browser: {
        cdpPort: 9222,
        cdpSourceRange: undefined,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        autoStartTimeoutMs: 12000,
      },
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      securityEpoch: "epoch-v1",
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      securityEpoch: "epoch-v2",
    });
    expect(left).not.toBe(right);
  });

  it("changes when cdp source range changes", () => {
    const shared = {
      docker: createDockerConfig(),
      browser: {
        cdpPort: 9222,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        autoStartTimeoutMs: 12000,
      },
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.21.0.1/32" },
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      browser: { ...shared.browser, cdpSourceRange: "172.22.0.1/32" },
    });
    expect(left).not.toBe(right);
  });

  it("changes when mount format version changes", () => {
    const shared = {
      docker: createDockerConfig(),
      browser: {
        cdpPort: 9222,
        cdpSourceRange: undefined,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        enableNoVnc: true,
        autoStartTimeoutMs: 12000,
      },
      securityEpoch: "epoch-v1",
      workspaceAccess: "rw" as const,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    };
    const left = computeSandboxBrowserConfigHash({
      ...shared,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    });
    const right = computeSandboxBrowserConfigHash({
      ...shared,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION - 1,
    });
    expect(left).not.toBe(right);
  });
});
