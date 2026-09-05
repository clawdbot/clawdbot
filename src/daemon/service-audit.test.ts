// Daemon service audit tests cover installed service inspection and warnings.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditGatewayServiceConfig,
  checkTokenDrift,
  needsNodeRuntimeMigration,
  SERVICE_AUDIT_CODES,
} from "./service-audit.js";
import { buildServiceEnvironment } from "./service-env.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

const SYSTEMD_CONTINUATIONS = ["", "\\\n  # continued setting \\\n  ; ignored comment\n  "];

const execSystemctlUser = vi.hoisted(() =>
  vi.fn<
    (
      env: NodeJS.ProcessEnv,
      args: string[],
      timeoutMs?: number,
    ) => Promise<{ stdout: string; stderr: string; code: number }>
  >(),
);

const resolveBunRuntimeInfo = vi.hoisted(() => vi.fn());

vi.mock("./runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-paths.js")>()),
  resolveBunRuntimeInfo,
}));

vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  execSystemctlUser,
}));

function buildMinimalServicePath(options: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}): string {
  const servicePath = buildServiceEnvironment({
    env: options.env,
    platform: options.platform,
    port: 18789,
  }).PATH;
  if (!servicePath) {
    throw new Error("expected managed service PATH");
  }
  return servicePath;
}

function hasIssue(
  audit: Awaited<ReturnType<typeof auditGatewayServiceConfig>>,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}

function createGatewayAudit({
  expectedGatewayToken,
  expectedManagedServiceEnvKeys,
  path: pathLocal = "/usr/local/bin:/usr/bin:/bin",
  serviceToken,
  extraEnvironment,
  environmentValueSources,
}: {
  expectedGatewayToken?: string;
  expectedManagedServiceEnvKeys?: Iterable<string>;
  path?: string;
  serviceToken?: string;
  extraEnvironment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
} = {}) {
  return auditGatewayServiceConfig({
    env: { HOME: "/tmp" },
    platform: "linux",
    expectedGatewayToken,
    expectedManagedServiceEnvKeys,
    command: {
      programArguments: ["/usr/bin/node", "gateway"],
      environment: {
        PATH: pathLocal,
        ...(serviceToken ? { OPENCLAW_GATEWAY_TOKEN: serviceToken } : {}),
        ...extraEnvironment,
      },
      ...(environmentValueSources ? { environmentValueSources } : {}),
    },
  });
}

async function writeSystemdUnitForAudit(
  home: string,
  lines: string[],
  unitName = "openclaw-gateway.service",
) {
  const unitDir = path.join(home, ".config", "systemd", "user");
  const unitPath = path.join(unitDir, unitName);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(
    unitPath,
    [
      "[Unit]",
      "Description=OpenClaw Gateway",
      "[Service]",
      ...lines,
      "ExecStart=/usr/bin/node gateway",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
    "utf8",
  );
}

function expectTokenAudit(
  audit: Awaited<ReturnType<typeof auditGatewayServiceConfig>>,
  {
    embedded,
    mismatch,
  }: {
    embedded: boolean;
    mismatch: boolean;
  },
) {
  expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayTokenEmbedded)).toBe(embedded);
  expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayTokenMismatch)).toBe(mismatch);
}

describe("auditGatewayServiceConfig", () => {
  beforeEach(() => {
    execSystemctlUser.mockReset();
    execSystemctlUser.mockResolvedValue({ stdout: "", stderr: "systemd unavailable", code: 1 });
    resolveBunRuntimeInfo.mockReset();
    resolveBunRuntimeInfo.mockResolvedValue({
      version: "1.4.0",
      sqliteVersion: "3.51.3",
      nodeSharedSqlite: false,
      status: "supported",
    });
  });

  it("flags Bun runtimes without WAL-safe SQLite", async () => {
    resolveBunRuntimeInfo.mockResolvedValue({
      version: "1.4.0",
      sqliteVersion: "3.51.2",
      nodeSharedSqlite: false,
      status: "unsupported",
    });
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/opt/homebrew/bin/bun", "gateway"],
        environment: { PATH: "/usr/bin:/bin" },
      },
    });
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(true);
    expect(
      audit.issues.find((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun)?.message,
    ).toContain("Bun 1.4+ with WAL-reset-safe node:sqlite is required");
  });

  it("accepts Bun 1.4 with WAL-safe node:sqlite", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/opt/homebrew/bin/bun", "gateway"],
        environment: { PATH: "/usr/bin:/bin" },
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(false);
  });

  it("reports a failed Bun probe without recommending runtime migration", async () => {
    resolveBunRuntimeInfo.mockResolvedValue({
      status: "probe-failed",
      error: new Error("Bun runtime probe failed at /opt/bun (cwd /root): EACCES"),
    });
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/opt/bun", "gateway"],
        environment: { PATH: "/usr/bin:/bin" },
      },
    });

    expect(audit.issues).toContainEqual(
      expect.objectContaining({
        code: SERVICE_AUDIT_CODES.gatewayRuntimeProbeFailed,
        detail: expect.stringContaining("/opt/bun (cwd /root): EACCES"),
      }),
    );
    expect(needsNodeRuntimeMigration(audit.issues)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(false);
  });

  it("flags version-managed node paths", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/Users/test/.nvm/versions/node/v22.0.0/bin/node", "gateway"],
        environment: {
          PATH: "/usr/bin:/bin:/Users/test/.nvm/versions/node/v22.0.0/bin",
        },
      },
    });
    expect(
      audit.issues.some(
        (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      ),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(true);
  });

  it("accepts Linux minimal PATH with user directories", async () => {
    const env = { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/pnpm" };
    const minimalPath = buildMinimalServicePath({ platform: "linux", env });
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: minimalPath },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(false);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("accepts canonical macOS gateway service PATH without user-bin defaults", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-home-"));
    try {
      const servicePath = buildMinimalServicePath({ platform: "darwin", env: { HOME: home } });
      expect(servicePath).toBe(
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      );

      const audit = await auditGatewayServiceConfig({
        env: { HOME: home },
        platform: "darwin",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: servicePath },
        },
      });

      expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissingDirs)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("requires Homebrew directories in canonical macOS gateway service PATH", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-home-"));
    try {
      const audit = await auditGatewayServiceConfig({
        env: { HOME: home },
        platform: "darwin",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
        },
      });

      const issue = audit.issues.find(
        (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
      );
      expect(issue?.message).toContain("/opt/homebrew/bin");
      expect(issue?.message).toContain("/opt/homebrew/sbin");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("still requires explicit env-configured tool roots in gateway service PATH", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/pnpm" },
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
    );
    expect(issue?.message).toContain("/opt/pnpm");
  });

  it("flags stale Linux version-manager and package-manager PATH entries", async () => {
    const env = { HOME: "/tmp/openclaw-testuser-nonminimal" };
    const minimalPath = buildMinimalServicePath({ platform: "linux", env });
    const staleEntries = [
      `${env.HOME}/.volta/bin`,
      `${env.HOME}/.asdf/shims`,
      `${env.HOME}/.nvm/current/bin`,
      `${env.HOME}/.local/share/fnm/current/bin`,
      `${env.HOME}/.fnm/current/bin`,
      `${env.HOME}/.local/share/pnpm`,
      "/opt/pnpm/bin",
    ];
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: [minimalPath, ...staleEntries].join(":") },
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
    );
    expect(issue?.detail).toContain(`${env.HOME}/.volta/bin`);
    expect(issue?.detail).toContain(`${env.HOME}/.local/share/fnm/current/bin`);
    expect(issue?.detail).toContain(`${env.HOME}/.local/share/pnpm`);
    expect(issue?.detail).toContain("/opt/pnpm/bin");
  });

  it("accepts an expected active OpenClaw bin even when it looks package-managed", async () => {
    const expectedServicePath = [
      "/opt/homebrew/opt/node/bin",
      "/Users/testuser/Library/pnpm",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");

    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/Users/testuser" },
      platform: "darwin",
      expectedServicePath,
      command: {
        programArguments: [
          "/opt/homebrew/opt/node/bin/node",
          "/opt/openclaw/dist/index.js",
          "gateway",
        ],
        environment: { PATH: expectedServicePath },
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissingDirs)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathNonMinimal)).toBe(false);
  });

  it("still flags unrelated non-minimal PATH entries beside the expected active bin", async () => {
    const expectedServicePath = [
      "/opt/homebrew/opt/node/bin",
      "/Users/testuser/Library/pnpm",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");

    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/Users/testuser" },
      platform: "darwin",
      expectedServicePath,
      command: {
        programArguments: [
          "/opt/homebrew/opt/node/bin/node",
          "/opt/openclaw/dist/index.js",
          "gateway",
        ],
        environment: { PATH: `${expectedServicePath}:/Users/testuser/.asdf/shims` },
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
    );
    expect(issue?.detail).not.toContain("/Users/testuser/Library/pnpm");
    expect(issue?.detail).toContain("/Users/testuser/.asdf/shims");
  });

  it("accepts Linux fnm aliases/default without requiring the legacy current symlink", async () => {
    const env = {
      HOME: "/tmp/openclaw-testuser",
      FNM_DIR: "/tmp/openclaw-testuser/.local/share/fnm",
    };
    const pathParts = buildMinimalServicePath({ platform: "linux", env })
      .split(":")
      .filter((entry) => !entry.includes("/fnm/current/bin"));
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: pathParts.join(":") },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("accepts Linux fnm current symlink without requiring aliases/default", async () => {
    const env = {
      HOME: "/tmp/openclaw-testuser",
      FNM_DIR: "/tmp/openclaw-testuser/.local/share/fnm",
    };
    const pathParts = buildMinimalServicePath({ platform: "linux", env })
      .split(":")
      .filter((entry) => !entry.includes("/fnm/aliases/default/bin"));
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: pathParts.join(":") },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("treats zsh -lc LaunchAgent commands as opaque for the gateway token audit", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      expectedPort: 18889,
      command: {
        programArguments: [
          "/bin/zsh",
          "-lc",
          "exec /usr/bin/node /opt/openclaw/dist/index.js gateway --port 18890",
        ],
        environment: {},
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayCommandMissing)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPortMismatch)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissing)).toBe(true);
  });

  it.each([
    ["non-shell command", ["/usr/local/bin/helper", "-lc", "exec node gateway"]],
    ["shell without an inline-command flag", ["/bin/zsh", "-l", "exec node gateway"]],
  ])("keeps exact gateway token audit for %s", async (_name, programArguments) => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments,
        environment: {},
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayCommandMissing)).toBe(true);
  });

  it("skips PATH drift checks for semicolon-delimited Windows paths", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "C:\\Users\\test" },
      platform: "win32",
      expectedServicePath: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
      command: {
        programArguments: ["C:\\Program Files\\nodejs\\node.exe", "gateway"],
        environment: {
          PATH: "C:\\Users\\test\\.nvm\\current\\bin;C:\\Windows\\System32",
        },
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissing)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissingDirs)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathNonMinimal)).toBe(false);
  });

  it("flags gateway service port drift from the expected config port", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port", "18789"],
        environment: {},
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPortMismatch,
    );
    expect(issue).toStrictEqual({
      code: SERVICE_AUDIT_CODES.gatewayPortMismatch,
      message: "Gateway service port does not match current gateway config.",
      detail: "18789 -> 18888",
      level: "recommended",
    });
  });

  it("flags explicit invalid gateway service ports", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port=65536"],
        environment: {},
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPortMismatch,
    );
    expect(issue).toStrictEqual({
      code: SERVICE_AUDIT_CODES.gatewayPortMismatch,
      message: "Gateway service port does not match current gateway config.",
      detail: "65536 -> 18888",
      level: "recommended",
    });
  });

  it("accepts gateway service ports that match the expected config port", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port=18888"],
        environment: {},
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPortMismatch)).toBe(false);
  });

  it("audits the final repeated gateway port flag", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: [
          "/usr/bin/node",
          "entry.js",
          "gateway",
          "--port",
          "18789",
          "--port=18888",
        ],
        environment: {},
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPortMismatch)).toBe(false);
  });

  it("does not reinterpret a consumed gateway port value as another flag", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port", "--port=18888"],
        environment: {},
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPortMismatch,
    );
    expect(issue?.detail).toBe("--port=18888 -> 18888");
  });

  it("flags gateway token mismatch when service token is stale", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
    });
    expectTokenAudit(audit, { embedded: true, mismatch: true });
  });

  it.each([
    {
      name: "uses manager KillMode instead of the base unit",
      unit: [
        "After=network-online.target",
        "Wants=network-online.target",
        "RestartSec=5",
        "KillMode=control-group",
      ],
      manager: [
        "KillMode=process",
        "RestartUSec=5s",
        "After=network-online.target",
        "Wants=network-online.target",
      ],
      code: SERVICE_AUDIT_CODES.systemdKillModeProcessOrNone,
      expected: true,
    },
    {
      name: "uses manager RestartUSec instead of the base unit",
      unit: [
        "After=network-online.target",
        "Wants=network-online.target",
        "RestartSec=100ms",
        "KillMode=control-group",
      ],
      manager: [
        "Wants=network-online.target",
        "KillMode=control-group",
        "RestartUSec=5s",
        "After=network-online.target",
      ],
      code: SERVICE_AUDIT_CODES.systemdRestartSec,
      expected: false,
    },
    {
      name: "uses manager After dependencies absent from the base unit",
      unit: ["Wants=network-online.target", "RestartSec=5", "KillMode=control-group"],
      manager: [
        "RestartUSec=5s",
        "After=basic.target network-online.target",
        "KillMode=control-group",
        "Wants=network-online.target",
      ],
      code: SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
      expected: false,
    },
    {
      name: "does not refill missing manager Wants from the base unit",
      unit: [
        "After=network-online.target",
        "Wants=network-online.target",
        "RestartSec=5",
        "KillMode=control-group",
      ],
      manager: [
        "After=network-online.target",
        "RestartUSec=5s",
        "Wants=basic.target",
        "KillMode=control-group",
      ],
      code: SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
      expected: true,
    },
  ])("respects systemd manager authority: $name", async ({ unit, manager, code, expected }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-manager-"));
    try {
      const unitName = "openclaw-audit.service";
      const env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: unitName };
      await writeSystemdUnitForAudit(home, unit, unitName);
      execSystemctlUser.mockResolvedValueOnce({
        stdout: manager.join("\n"),
        stderr: "",
        code: 0,
      });

      const audit = await auditGatewayServiceConfig({
        env,
        platform: "linux",
        timeoutMs: 321,
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: "/usr/bin:/bin" },
        },
      });

      expect(hasIssue(audit, code)).toBe(expected);
      expect(execSystemctlUser).toHaveBeenCalledExactlyOnceWith(
        env,
        ["show", unitName, "--no-page", "--property", "After,Wants,RestartUSec,KillMode"],
        321,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each(["process", "none"])(
    `warns when KillMode is %s in explicit unit file`,
    async (killMode) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-killmode-"));
      try {
        for (const continuation of SYSTEMD_CONTINUATIONS) {
          await writeSystemdUnitForAudit(home, [
            "After=network-online.target",
            "Wants=network-online.target",
            "RestartSec=5",
            `KillMode=${continuation}${killMode}`,
          ]);

          const audit = await auditGatewayServiceConfig({
            env: { HOME: home },
            platform: "linux",
            command: {
              programArguments: ["/usr/bin/node", "gateway"],
              environment: { PATH: "/usr/bin:/bin" },
            },
          });
          expect(hasIssue(audit, SERVICE_AUDIT_CODES.systemdKillModeProcessOrNone)).toBe(true);
          expect(execSystemctlUser).toHaveBeenCalledWith({ HOME: home }, expect.any(Array), 10_000);
        }
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each(SYSTEMD_CONTINUATIONS)(
    "accepts resilient unit settings with continuation %j when the manager is unavailable",
    async (continuation) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-settings-"));
      try {
        await writeSystemdUnitForAudit(home, [
          `After=basic.target ${continuation}network-online.target`,
          `Wants=basic.target ${continuation}network-online.target`,
          `RestartSec=${continuation}5s`,
          `KillMode=${continuation}control-group`,
        ]);
        const audit = await auditGatewayServiceConfig({
          env: { HOME: home },
          platform: "linux",
          command: {
            programArguments: ["/usr/bin/node", "gateway"],
            environment: { PATH: "/usr/bin:/bin" },
          },
        });
        expect(audit.issues.filter((issue) => issue.code.startsWith("systemd-"))).toEqual([]);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: "embedded credentials",
      content:
        'Environment = "OPENCLAW_GATEWAY_TOKEN=audit-token" SAFE=kept \\\n  "OPENCLAW_GATEWAY_PASSWORD=audit-password"\n',
      mode: 0o600,
      expectedDetail: "OPENCLAW_GATEWAY_PASSWORD, OPENCLAW_GATEWAY_TOKEN",
    },
    {
      name: "permissive mode",
      content: "Environment=OPERATOR_SETTING=kept\n",
      mode: 0o644,
      expectedDetail: "mode: 644",
    },
  ])("flags systemd unit backups with $name without revealing values", async (fixture) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-backup-"));
    try {
      await writeSystemdUnitForAudit(home, [
        "After=network-online.target",
        "Wants=network-online.target",
        "RestartSec=5",
        "KillMode=control-group",
      ]);
      const backupPath = path.join(
        home,
        ".config",
        "systemd",
        "user",
        "openclaw-gateway.service.bak",
      );
      await fs.writeFile(backupPath, fixture.content, { mode: fixture.mode });
      await fs.chmod(backupPath, fixture.mode);

      const audit = await auditGatewayServiceConfig({
        env: { HOME: home },
        platform: "linux",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: "/usr/bin:/bin" },
        },
      });
      const issue = audit.issues.find(
        (entry) => entry.code === SERVICE_AUDIT_CODES.systemdUnitBackupUnsafe,
      );
      expect(issue).toMatchObject({
        level: "recommended",
        detail: expect.stringContaining(fixture.expectedDetail),
      });
      expect(JSON.stringify(issue)).not.toContain("audit-token");
      expect(JSON.stringify(issue)).not.toContain("audit-password");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("audits an orphaned systemd backup without an active command", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-orphan-"));
    try {
      const backupPath = path.join(
        home,
        ".config",
        "systemd",
        "user",
        "openclaw-gateway.service.bak",
      );
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, "Environment=OPENCLAW_GATEWAY_TOKEN=orphan-token\n", {
        mode: 0o600,
      });

      const audit = await auditGatewayServiceConfig({
        env: { HOME: home },
        platform: "linux",
        command: null,
      });

      expect(hasIssue(audit, SERVICE_AUDIT_CODES.systemdUnitBackupUnsafe)).toBe(true);
      expect(JSON.stringify(audit.issues)).not.toContain("orphan-token");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("flags embedded service token even when it matches config token", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "new-token",
    });
    expectTokenAudit(audit, { embedded: true, mismatch: false });
  });

  it("flags an embedded service password without revealing it", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: { OPENCLAW_GATEWAY_PASSWORD: "active-password" },
    });
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPasswordEmbedded)).toBe(true);
    expect(JSON.stringify(audit.issues)).not.toContain("active-password");
  });

  it("does not flag token issues when service token is not embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
    });
    expectTokenAudit(audit, { embedded: false, mismatch: false });
  });

  it("does not treat EnvironmentFile-backed tokens as embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
      environmentValueSources: {
        OPENCLAW_GATEWAY_TOKEN: "file",
      },
    });
    expectTokenAudit(audit, { embedded: false, mismatch: false });
  });

  it("treats tokens present inline and in EnvironmentFile as embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
      environmentValueSources: {
        OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
      },
    });
    expectTokenAudit(audit, { embedded: true, mismatch: true });
  });

  it("flags inline managed service env values from the service key list", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY,OPENROUTER_API_KEY",
        TAVILY_API_KEY: "tvly-test",
        OPENROUTER_API_KEY: "or-test",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded,
    );
    expect(issue?.detail).toContain("OPENROUTER_API_KEY");
    expect(issue?.detail).toContain("TAVILY_API_KEY");
    expect(issue?.environmentKeys).toEqual(["OPENROUTER_API_KEY", "TAVILY_API_KEY"]);
  });

  it("flags inline managed values expected by the current install plan for old services", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(true);
  });

  it("does not flag managed env values loaded from EnvironmentFile", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
      environmentValueSources: {
        TAVILY_API_KEY: "file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(false);
  });

  it("flags managed env values present inline even when an EnvironmentFile overrides them", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
      environmentValueSources: {
        TAVILY_API_KEY: "inline-and-file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(true);
  });

  it("flags inline proxy environment values embedded in the service", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
        HTTPS_PROXY: "https://proxy.local:7890",
        NO_PROXY: "localhost,127.0.0.1",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    );
    expect(issue?.detail).toContain("HTTP_PROXY");
    expect(issue?.detail).toContain("HTTPS_PROXY");
    expect(issue?.detail).toContain("NO_PROXY");
    expect(issue?.environmentKeys).toEqual(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]);
  });

  it("flags lowercase inline proxy environment values using portable key names", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        https_proxy: "https://proxy.local:7890",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    );
    expect(issue?.detail).toContain("HTTPS_PROXY");
    expect(issue?.environmentKeys).toEqual(["https_proxy"]);
  });

  it("does not flag proxy values loaded only from EnvironmentFile", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
      },
      environmentValueSources: {
        HTTP_PROXY: "file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded)).toBe(false);
  });

  it("flags proxy values present inline even when an EnvironmentFile overrides them", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
      },
      environmentValueSources: {
        HTTP_PROXY: "inline-and-file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded)).toBe(true);
  });

  it("matches managed and proxy source metadata keys case-insensitively", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
        HTTPS_PROXY: "https://proxy.local:7890",
      },
      environmentValueSources: {
        tavily_api_key: "file",
        https_proxy: "file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(false);
    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded)).toBe(false);
  });
});

describe("checkTokenDrift", () => {
  it("returns null when both tokens are undefined", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: undefined });
    expect(result).toBeNull();
  });

  it("returns null when both tokens are empty strings", () => {
    const result = checkTokenDrift({ serviceToken: "", configToken: "" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match", () => {
    const result = checkTokenDrift({ serviceToken: "same-token", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match but service token has trailing newline", () => {
    const result = checkTokenDrift({ serviceToken: "same-token\n", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match but have surrounding whitespace", () => {
    const result = checkTokenDrift({ serviceToken: "  same-token  ", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when both tokens have different whitespace padding", () => {
    const result = checkTokenDrift({
      serviceToken: "same-token\r\n",
      configToken: " same-token ",
    });
    expect(result).toBeNull();
  });

  it("detects token drift without choosing an installation action", () => {
    const result = checkTokenDrift({ serviceToken: "old-token", configToken: "new-token" });
    expect(result).toStrictEqual({
      code: SERVICE_AUDIT_CODES.gatewayTokenDrift,
      message:
        "Config token differs from service token. The daemon will use the old token after restart.",
      level: "recommended",
    });
  });

  it("returns null when config has token but service has no token", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: "new-token" });
    expect(result).toBeNull();
  });

  it("returns null when service has token but config does not", () => {
    // This is not really drift - service will work, just config is incomplete
    const result = checkTokenDrift({ serviceToken: "service-token", configToken: undefined });
    expect(result).toBeNull();
  });
});

describe("legacy gateway service version metadata", () => {
  it("does not treat install-time version metadata as runtime truth", async () => {
    const legacyAudit = await createGatewayAudit({
      extraEnvironment: { OPENCLAW_SERVICE_VERSION: "2026.4.15-beta.1" },
    });
    const canonicalAudit = await createGatewayAudit();

    expect(legacyAudit).toEqual(canonicalAudit);
  });
});
