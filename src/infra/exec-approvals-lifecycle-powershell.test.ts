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
});
