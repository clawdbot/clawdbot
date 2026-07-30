import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(command: string, argv: string[]): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    platform: "win32",
    segments: [{ raw: command, argv }],
  });
}

describe("OpenClaw plugin and hook lifecycle approvals", () => {
  it.each([
    ["openclaw plugins enable memory", ["openclaw", "plugins", "enable", "memory"]],
    ["openclaw plugins disable memory", ["openclaw", "plugins", "disable", "memory"]],
    ["openclaw plugins install @acme/tool", ["openclaw", "plugins", "install", "@acme/tool"]],
    ["openclaw plugins update memory", ["openclaw", "plugins", "update", "memory"]],
    [
      "openclaw plugins update memory --dry-run --dry-run=false",
      ["openclaw", "plugins", "update", "memory", "--dry-run", "--dry-run=false"],
    ],
    ["openclaw plugins uninstall memory", ["openclaw", "plugins", "uninstall", "memory"]],
    ["openclaw plugins registry --refresh", ["openclaw", "plugins", "registry", "--refresh"]],
    ["openclaw plugins build", ["openclaw", "plugins", "build"]],
    ["openclaw plugins init sample", ["openclaw", "plugins", "init", "sample"]],
    ["openclaw plugins marketplace refresh", ["openclaw", "plugins", "marketplace", "refresh"]],
    ["openclaw hooks enable audit", ["openclaw", "hooks", "enable", "audit"]],
    ["openclaw hooks disable audit", ["openclaw", "hooks", "disable", "audit"]],
    ["openclaw hooks install ./pack", ["openclaw", "hooks", "install", "./pack"]],
    ["openclaw hooks update audit", ["openclaw", "hooks", "update", "audit"]],
  ] as Array<[string, string[]]>)("classifies mutating command: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it.each([
    ["openclaw plugins list", ["openclaw", "plugins", "list"]],
    ["openclaw plugins inspect memory", ["openclaw", "plugins", "inspect", "memory"]],
    ["openclaw plugins install --help", ["openclaw", "plugins", "install", "--help"]],
    [
      "openclaw plugins update memory --dry-run",
      ["openclaw", "plugins", "update", "memory", "--dry-run"],
    ],
    [
      "openclaw plugins uninstall memory --dry-run",
      ["openclaw", "plugins", "uninstall", "memory", "--dry-run"],
    ],
    ["openclaw plugins registry", ["openclaw", "plugins", "registry"]],
    [
      "openclaw plugins registry --refresh=false",
      ["openclaw", "plugins", "registry", "--refresh=false"],
    ],
    ["openclaw plugins build --check", ["openclaw", "plugins", "build", "--check"]],
    [
      "openclaw plugins marketplace list ./marketplace",
      ["openclaw", "plugins", "marketplace", "list", "./marketplace"],
    ],
    ["openclaw hooks list", ["openclaw", "hooks", "list"]],
    ["openclaw hooks install --help", ["openclaw", "hooks", "install", "--help"]],
    [
      "openclaw hooks update audit --dry-run",
      ["openclaw", "hooks", "update", "audit", "--dry-run"],
    ],
    [
      "openclaw hooks update audit --dry-run=false --dry-run",
      ["openclaw", "hooks", "update", "audit", "--dry-run=false", "--dry-run"],
    ],
  ] as Array<[string, string[]]>)("keeps read-only command non-blocking: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(false);
  });
});

describe("OpenClaw PowerShell filter pipeline approvals", () => {
  it.each([
    [
      "Get-Process | Where-Object ProcessName -Like 'openclaw*' | Stop-Process",
      [
        "Get-Process",
        "|",
        "Where-Object",
        "ProcessName",
        "-Like",
        "openclaw*",
        "|",
        "Stop-Process",
      ],
    ],
    [
      "Get-Service | ? Name -Like 'openclaw*' | Restart-Service",
      ["Get-Service", "|", "?", "Name", "-Like", "openclaw*", "|", "Restart-Service"],
    ],
  ] as Array<[string, string[]]>)("classifies filtered mutation: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it("keeps unrelated filtered mutations non-blocking", () => {
    const command = "Get-Process | Where-Object ProcessName -Like 'node*' | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "ProcessName",
        "-Like",
        "node*",
        "|",
        "Stop-Process",
      ]),
    ).toBe(false);
  });
});
