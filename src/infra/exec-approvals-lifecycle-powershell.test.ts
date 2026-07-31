import { describe, expect, it } from "vitest";
import { extractShellSubstitutionCommands } from "./exec-approvals-lifecycle-substitutions.js";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(command: string, argv: string[]): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    platform: "win32",
    segments: [{ raw: command, argv }],
  });
}

describe("OpenClaw PowerShell lifecycle edges", () => {
  it("scans lifecycle substitutions inside double quotes", () => {
    const command = `Write-Output "$(openclaw gateway restart)"`;
    expect(extractShellSubstitutionCommands(command, "powershell").commands).toContain(
      "openclaw gateway restart",
    );
    expect(requiresApproval(command, ["Write-Output", "$(openclaw gateway restart)"])).toBe(true);
  });

  it("keeps OpenClaw selected by a negative unrelated identity filter", () => {
    const command = "Get-Process | Where-Object ProcessName -NotLike 'node*' | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "ProcessName",
        "-NotLike",
        "node*",
        "|",
        "Stop-Process",
      ]),
    ).toBe(true);
  });

  it("allows a negative filter that excludes OpenClaw", () => {
    const command = "Get-Process | Where-Object ProcessName -NotLike '*claw*' | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "ProcessName",
        "-NotLike",
        "*claw*",
        "|",
        "Stop-Process",
      ]),
    ).toBe(false);
  });

  it("keeps OpenClaw selected by a compound negative filter", () => {
    const command =
      "Get-Process | Where-Object { $_.ProcessName -NotLike '*claw*' -or 1 -eq 1 } | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "{",
        "$_.ProcessName",
        "-NotLike",
        "*claw*",
        "-or",
        "1",
        "-eq",
        "1",
        "}",
        "|",
        "Stop-Process",
      ]),
    ).toBe(true);
  });

  it("inspects mutations nested in pipeline script blocks", () => {
    const command = "Get-Process OpenClaw | ForEach-Object { Stop-Process -InputObject $_ }";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "OpenClaw",
        "|",
        "ForEach-Object",
        "{",
        "Stop-Process",
        "-InputObject",
        "$_",
        "}",
      ]),
    ).toBe(true);
  });

  it("tracks OpenClaw aliases across PowerShell fragments", () => {
    const command = "Set-Alias oc openclaw; oc exec-policy preset yolo";
    expect(requiresApproval(command, ["oc", "exec-policy", "preset", "yolo"])).toBe(true);
    expect(requiresApproval("Set-Alias oc openclaw; oc status", ["oc", "status"])).toBe(false);
  });
});
