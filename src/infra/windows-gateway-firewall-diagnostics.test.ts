// Windows Gateway firewall diagnostics classify LAN reachability risks.
import { describe, expect, it, vi } from "vitest";
import { inspectWindowsGatewayFirewall } from "./windows-gateway-firewall-diagnostics.js";
import { getWindowsPowerShellExePath, getWindowsSystem32ExePath } from "./windows-install-roots.js";

type InspectOptions = Parameters<typeof inspectWindowsGatewayFirewall>[0];
type FirewallCommandRunner = NonNullable<InspectOptions["runCommandWithTimeout"]>;

function stateJson(params?: {
  networkCategory?: string;
  defaultInboundAction?: string;
  allowInboundRules?: string;
  activeAllowLocalRules?: string;
  localAllowRules?: string;
}) {
  return JSON.stringify({
    ConnectionProfiles: [
      {
        InterfaceAlias: "Ethernet",
        NetworkCategory: params?.networkCategory ?? "Public",
      },
    ],
    ActiveFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: params?.defaultInboundAction ?? "Block",
        AllowInboundRules: params?.allowInboundRules ?? "True",
        AllowLocalFirewallRules: params?.activeAllowLocalRules ?? "True",
      },
    ],
    LocalFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "NotConfigured",
        AllowInboundRules: "NotConfigured",
        AllowLocalFirewallRules: params?.localAllowRules ?? "NotConfigured",
      },
    ],
  });
}

function multiProfileStateJson() {
  return JSON.stringify({
    ConnectionProfiles: [
      {
        InterfaceAlias: "Ethernet",
        NetworkCategory: "Public",
      },
      {
        InterfaceAlias: "Wi-Fi",
        NetworkCategory: "Private",
      },
    ],
    ActiveFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "Block",
        AllowInboundRules: "True",
        AllowLocalFirewallRules: "False",
      },
      {
        Name: "Private",
        Enabled: "True",
        DefaultInboundAction: "Block",
        AllowInboundRules: "True",
        AllowLocalFirewallRules: "True",
      },
    ],
    LocalFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "NotConfigured",
        AllowInboundRules: "NotConfigured",
        AllowLocalFirewallRules: "NotConfigured",
      },
      {
        Name: "Private",
        Enabled: "True",
        DefaultInboundAction: "NotConfigured",
        AllowInboundRules: "NotConfigured",
        AllowLocalFirewallRules: "NotConfigured",
      },
    ],
  });
}

function ruleJson(params?: {
  displayName?: string;
  profile?: string;
  policyStoreSource?: string;
  policyStoreSourceType?: string;
  program?: string;
  localAddress?: string;
  remoteAddress?: string;
}) {
  return JSON.stringify([ruleRow(params)]);
}

function quickPayloadJson(params?: {
  state?: string;
  activeRules?: Array<Record<string, unknown>>;
  localRules?: Array<Record<string, unknown>>;
}) {
  return JSON.stringify({
    State: JSON.parse(params?.state ?? stateJson({ localAllowRules: "True" })),
    ActiveRules: params?.activeRules ?? [],
    LocalRules: params?.localRules ?? [ruleRow()],
  });
}

function rulesPayloadJson(params: { active?: unknown[]; local?: unknown[] }) {
  return JSON.stringify({
    ActiveRules: params.active ?? [],
    LocalRules: params.local ?? [],
  });
}

function ruleRow(params?: {
  displayName?: string;
  profile?: string;
  policyStoreSource?: string;
  policyStoreSourceType?: string;
  program?: string;
  localAddress?: string;
  remoteAddress?: string;
}) {
  return {
    DisplayName: params?.displayName ?? "OpenClaw Gateway",
    Profile: params?.profile ?? "Any",
    PolicyStoreSource: params?.policyStoreSource ?? "PersistentStore",
    PolicyStoreSourceType: params?.policyStoreSourceType ?? "Local",
    Program: params?.program ?? "Any",
    LocalAddress: params?.localAddress ?? "Any",
    RemoteAddress: params?.remoteAddress ?? "Any",
  };
}

async function classify(params: { stateJson: string; rulesJson: string; netshOutput?: string }) {
  const parsedRules = JSON.parse(params.rulesJson) as unknown;
  const rulePayload =
    parsedRules && typeof parsedRules === "object" && !Array.isArray(parsedRules)
      ? (parsedRules as { ActiveRules?: unknown; LocalRules?: unknown })
      : undefined;
  const activeRules = Array.isArray(rulePayload?.ActiveRules) ? rulePayload.ActiveRules : [];
  const localRules = Array.isArray(rulePayload?.LocalRules)
    ? rulePayload.LocalRules
    : Array.isArray(parsedRules)
      ? parsedRules
      : [];
  const runner: FirewallCommandRunner = async (argv) => {
    const command = argv.join(" ");
    if (command.includes("Get-NetConnectionProfile")) {
      return { code: 0, stdout: params.stateJson };
    }
    if (command.includes("HNetCfg.FwPolicy2")) {
      return { code: 0, stdout: JSON.stringify(localRules) };
    }
    if (command.includes("PolicyStore ActiveStore")) {
      return { code: 0, stdout: JSON.stringify(activeRules) };
    }
    if (command.includes("PolicyStore PersistentStore")) {
      return { code: 0, stdout: JSON.stringify(localRules) };
    }
    if (command.includes("advfirewall")) {
      return { code: 0, stdout: params.netshOutput ?? "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return await inspectWindowsGatewayFirewall({
    bind: "lan",
    port: 18789,
    platform: "win32",
    runCommandWithTimeout: runner,
  });
}

describe("Windows Gateway firewall diagnostics", () => {
  it("does not run commands outside Windows LAN binding", async () => {
    const runner = vi.fn<FirewallCommandRunner>();

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "loopback",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      applies: false,
      code: "windows_firewall_not_applicable",
    });
    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "darwin",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      applies: false,
      code: "windows_firewall_not_applicable",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("detects managed Windows policy that ignores local Gateway allow rules", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({
        activeAllowLocalRules: "False",
        localAllowRules: "NotConfigured",
      }),
      rulesJson: ruleJson(),
      netshOutput: "LocalFirewallRules N/A (GPO-store only)",
    });

    expect(diagnostic).toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
    expect(diagnostic.details.join("\n")).toContain("GPO-store only");
  });

  it("detects ignored local rules even when they are absent from ActiveStore", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({
        activeAllowLocalRules: "False",
        localAllowRules: "NotConfigured",
      }),
      rulesJson: rulesPayloadJson({
        active: [],
        local: [ruleRow()],
      }),
      netshOutput: "LocalFirewallRules N/A (GPO-store only)",
    });

    expect(diagnostic).toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
    expect(diagnostic.details.join("\n")).toContain("OpenClaw Gateway");
  });

  it("requires every active profile to allow local firewall rules", async () => {
    await expect(
      classify({
        stateJson: multiProfileStateJson(),
        rulesJson: rulesPayloadJson({
          active: [],
          local: [ruleRow()],
        }),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
  });

  it("does not treat NotConfigured local-rule policy as blocked", async () => {
    await expect(
      classify({
        stateJson: stateJson({ localAllowRules: "NotConfigured" }),
        rulesJson: ruleJson(),
        netshOutput: "LocalFirewallRules N/A (GPO-store only)",
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "info",
      code: "windows_firewall_rule_present",
    });
  });

  it("accepts a local allow rule when local rules are enabled for the active profile", async () => {
    await expect(
      classify({
        stateJson: stateJson({ localAllowRules: "True" }),
        rulesJson: ruleJson(),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "info",
      code: "windows_firewall_rule_present",
    });
  });

  it("rejects allow rules when the active profile blocks inbound rules globally", async () => {
    await expect(
      classify({
        stateJson: stateJson({ allowInboundRules: "False", localAllowRules: "True" }),
        rulesJson: ruleJson(),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_inbound_rules_disabled",
    });
  });

  it("does not treat program-scoped rules as sufficient Gateway allow rules", async () => {
    await expect(
      classify({
        stateJson: stateJson({ localAllowRules: "True" }),
        rulesJson: ruleJson({ program: "C:\\Other\\server.exe" }),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_program_scoped_rule_unverified",
    });
  });

  it("does not treat address-scoped rules as sufficient Gateway allow rules", async () => {
    await expect(
      classify({
        stateJson: stateJson({ localAllowRules: "True" }),
        rulesJson: ruleJson({ remoteAddress: "192.168.1.20" }),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_address_scoped_rule_unverified",
    });
  });

  it("detects a Gateway allow rule on the wrong Windows network profile", async () => {
    await expect(
      classify({
        stateJson: stateJson({ networkCategory: "Public" }),
        rulesJson: ruleJson({ profile: "Private" }),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_rule_profile_mismatch",
    });
  });

  it("prefers managed rule profile mismatch over local-rule-disabled fallback", async () => {
    await expect(
      classify({
        stateJson: stateJson({
          networkCategory: "Public",
          activeAllowLocalRules: "False",
        }),
        rulesJson: rulesPayloadJson({
          active: [
            ruleRow({
              displayName: "Managed private allow",
              profile: "Private",
              policyStoreSource: "Intune",
              policyStoreSourceType: "MDM",
            }),
          ],
          local: [],
        }),
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_rule_profile_mismatch",
    });
  });

  it("detects a blocking profile with no inbound allow rule for the Gateway port", async () => {
    await expect(
      classify({
        stateJson: stateJson(),
        rulesJson: "[]",
      }),
    ).resolves.toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_no_allow_rule",
    });
  });

  it("classifies empty successful rule output as no allow rule", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      if (command.includes("Get-NetConnectionProfile")) {
        return { code: 0, stdout: stateJson() };
      }
      if (command.includes("HNetCfg.FwPolicy2")) {
        return { code: 0, stdout: "" };
      }
      if (command.includes("advfirewall")) {
        return { code: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_no_allow_rule",
    });
  });

  it("fails closed when firewall rule output is truncated", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      if (command.includes("Get-NetConnectionProfile")) {
        return { code: 0, stdout: stateJson() };
      }
      if (command.includes("HNetCfg.FwPolicy2")) {
        return { code: 0, stdout: ruleJson(), stdoutTruncatedBytes: 1 };
      }
      if (command.includes("advfirewall")) {
        return { code: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_inspection_failed",
    });
  });

  it("reports local-rule policy when the persistent detail probe is unavailable", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv, opts) => {
      const command = argv.join(" ");
      if (command.includes("Get-NetConnectionProfile")) {
        return { code: 0, stdout: stateJson({ activeAllowLocalRules: "False" }) };
      }
      if (command.includes("HNetCfg.FwPolicy2")) {
        return { code: 0, stdout: "" };
      }
      if (command.includes("PolicyStore ActiveStore")) {
        return { code: 0, stdout: "" };
      }
      if (command.includes("PolicyStore PersistentStore")) {
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(10_000);
        return { code: null, stdout: "" };
      }
      if (command.includes("advfirewall")) {
        return { code: 0, stdout: "LocalFirewallRules N/A (GPO-store only)" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_local_rules_ignored",
    });
  });

  it("preserves managed ActiveStore allow rules when local rules are disabled", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      if (command.includes("Get-NetConnectionProfile")) {
        return { code: 0, stdout: stateJson({ activeAllowLocalRules: "False" }) };
      }
      if (command.includes("HNetCfg.FwPolicy2")) {
        return { code: 0, stdout: ruleJson({ displayName: "Ignored local allow" }) };
      }
      if (command.includes("PolicyStore ActiveStore")) {
        expect(command).toContain("requestedPolicyStoreSourceTypes");
        expect(command).toContain("-ieq");
        expect(command).toContain("GroupPolicy");
        expect(command).toContain("MDM");
        return {
          code: 0,
          stdout: ruleJson({
            displayName: "MDM-managed Gateway allow",
            policyStoreSource: "Intune",
            policyStoreSourceType: "MDM",
          }),
        };
      }
      if (command.includes("advfirewall")) {
        return { code: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      severity: "info",
      code: "windows_firewall_rule_present",
    });
    expect(
      runner.mock.calls.some(([argv]) => argv.join(" ").includes("PolicyStore PersistentStore")),
    ).toBe(false);
  });

  it("keeps broad any-port rules from structured Windows rule output", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({ localAllowRules: "True" }),
      rulesJson: rulesPayloadJson({ active: [ruleRow({ displayName: "Broad TCP allow" })] }),
    });

    expect(diagnostic).toMatchObject({
      severity: "info",
      code: "windows_firewall_rule_present",
    });
  });

  it("treats COM wildcard addresses as address-agnostic", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({ localAllowRules: "True" }),
      rulesJson: rulesPayloadJson({
        active: [ruleRow({ localAddress: "*", remoteAddress: "*" })],
      }),
    });

    expect(diagnostic).toMatchObject({
      severity: "info",
      code: "windows_firewall_rule_present",
    });
  });

  it("does not treat app-scoped any-port rules as sufficient Gateway allow rules", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({ localAllowRules: "True" }),
      rulesJson: rulesPayloadJson({
        active: [ruleRow({ displayName: "Microsoft Teams", program: "Microsoft Teams" })],
      }),
    });

    expect(diagnostic).toMatchObject({
      severity: "warning",
      code: "windows_firewall_program_scoped_rule_unverified",
    });
  });

  it("does not treat service-scoped explicit port rules as sufficient Gateway allow rules", async () => {
    const diagnostic = await classify({
      stateJson: stateJson({ localAllowRules: "True" }),
      rulesJson: rulesPayloadJson({
        active: [ruleRow({ displayName: "Service rule", program: "SomeService" })],
      }),
    });

    expect(diagnostic).toMatchObject({
      severity: "warning",
      code: "windows_firewall_program_scoped_rule_unverified",
    });
  });

  it("runs a quick bounded Windows probe without netsh or follow-up commands", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      expect(command).toContain("Get-NetConnectionProfile");
      expect(command).toContain("HNetCfg.FwPolicy2");
      expect(command).toContain("Get-NetFirewallRule");
      expect(command).toContain("PolicyStore ActiveStore");
      expect(command).toContain("foreach ($entry in @($value))");
      expect(command).not.toContain("advfirewall");
      expect(command).not.toContain("PolicyStore PersistentStore");
      return { code: 0, stdout: quickPayloadJson() };
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        mode: "quick",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_rule_present",
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0][0]).toBe(getWindowsPowerShellExePath());
    expect(runner.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 5_000,
    });
  });

  it("preserves managed ActiveStore allow rules during quick inspection", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      expect(command).toContain("Get-NetFirewallRule");
      expect(command).toContain("GroupPolicy");
      expect(command).toContain("MDM");
      return {
        code: 0,
        stdout: quickPayloadJson({
          state: stateJson({ activeAllowLocalRules: "False" }),
          activeRules: [
            ruleRow({
              displayName: "MDM-managed Gateway allow",
              policyStoreSource: "Intune",
              policyStoreSourceType: "MDM",
            }),
          ],
          localRules: [ruleRow({ displayName: "Ignored local allow" })],
        }),
      };
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        mode: "quick",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      severity: "info",
      code: "windows_firewall_rule_present",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("runs bounded read-only full Windows probes for LAN binding", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      if (command.includes("Get-NetConnectionProfile")) {
        return { code: 0, stdout: stateJson({ localAllowRules: "True" }) };
      }
      if (command.includes("HNetCfg.FwPolicy2")) {
        expect(command).toContain("$targetPort = 18789");
        expect(command).not.toContain("Grouping");
        expect(command).not.toContain("Description");
        expect(command).toContain("System.Collections.ArrayList");
        expect(command).toContain("$matchingRules.Add");
        expect(command).toContain("[string]$rule.LocalAddresses");
        expect(command).toContain("[string]$rule.RemoteAddresses");
        return { code: 0, stdout: ruleJson() };
      }
      if (command.includes("advfirewall")) {
        return { code: 0, stdout: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
        timeoutMs: 1234,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_rule_present",
    });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.map(([argv]) => argv[0])).toEqual(
      expect.arrayContaining([
        getWindowsPowerShellExePath(),
        getWindowsSystem32ExePath("netsh.exe"),
      ]),
    );
    for (const [, opts] of runner.mock.calls) {
      expect(opts).toMatchObject({ timeoutMs: 1234 });
    }

    runner.mockClear();
    await expect(
      inspectWindowsGatewayFirewall({
        bind: "lan",
        port: 18789,
        platform: "win32",
        runCommandWithTimeout: runner,
      }),
    ).resolves.toMatchObject({
      code: "windows_firewall_rule_present",
    });
    expect(runner).toHaveBeenCalledTimes(3);
    for (const [, opts] of runner.mock.calls) {
      expect(opts).toMatchObject({ timeoutMs: 5_000 });
    }
  });
});
