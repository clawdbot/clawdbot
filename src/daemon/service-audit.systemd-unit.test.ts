// Daemon service audit tests cover systemd unit content read from the manager and disk.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/service-audit-mocks.js";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "./service-audit.js";
import {
  execSystemctlUserMock,
  hasIssue,
  resetServiceAuditMocks,
} from "./test-helpers/service-audit-fixtures.js";

const SYSTEMD_CONTINUATIONS = ["", "\\\n  # continued setting \\\n  ; ignored comment\n  "];

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

describe("auditGatewayServiceConfig systemd unit content", () => {
  beforeEach(() => {
    resetServiceAuditMocks();
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
        "LoadState=loaded",
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
        "LoadState=loaded",
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
        "LoadState=loaded",
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
        "LoadState=loaded",
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
      execSystemctlUserMock.mockResolvedValueOnce({
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
      expect(execSystemctlUserMock).toHaveBeenCalledExactlyOnceWith(
        env,
        ["show", unitName, "--no-page", "--property", "After,Wants,RestartUSec,KillMode,LoadState"],
        321,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "masked",
      // systemd 259: `systemctl --user show` exits 0 for a /dev/null mask with
      // empty After/Wants and RestartUSec=100ms. Those defaults are not the
      // unit's configured settings.
      manager: [
        "Wants=",
        "After=",
        "LoadState=masked",
        'LoadError=org.freedesktop.systemd1.UnitMasked "Unit openclaw-audit.service is masked."',
        "RestartUSec=100ms",
        "KillMode=control-group",
      ],
    },
    {
      name: "not-found",
      manager: [
        "Wants=",
        "After=",
        "LoadState=not-found",
        'LoadError=org.freedesktop.systemd1.NoSuchUnit "Unit openclaw-audit.service not found."',
        "RestartUSec=100ms",
        "KillMode=control-group",
      ],
    },
  ])(
    "does not recommend systemd content repairs when manager LoadState is $name",
    async ({ manager }) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-unloaded-"));
      try {
        const unitName = "openclaw-audit.service";
        const env = { HOME: home, OPENCLAW_SYSTEMD_UNIT: unitName };
        await writeSystemdUnitForAudit(
          home,
          // Keep the on-disk unit incomplete so a file fallback would still
          // emit content repairs. Masked/not-found manager defaults must not.
          ["KillMode=control-group"],
          unitName,
        );
        execSystemctlUserMock.mockResolvedValueOnce({
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

        expect(audit.issues.filter((issue) => issue.code.startsWith("systemd-"))).toEqual([]);
        expect(execSystemctlUserMock).toHaveBeenCalledExactlyOnceWith(
          env,
          [
            "show",
            unitName,
            "--no-page",
            "--property",
            "After,Wants,RestartUSec,KillMode,LoadState",
          ],
          321,
        );
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

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
          expect(execSystemctlUserMock).toHaveBeenCalledWith(
            { HOME: home },
            expect.any(Array),
            10_000,
          );
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
});
