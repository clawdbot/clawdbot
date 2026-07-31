import { describe, expect, it } from "vitest";
import { extractShellSubstitutionCommands } from "./exec-approvals-lifecycle-substitutions.js";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(
  command: string,
  argv: string[],
  env?: NodeJS.ProcessEnv,
  envComplete?: boolean,
): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    env,
    envComplete,
    platform: "win32",
    segments: [{ raw: command, argv }],
  });
}

describe("OpenClaw PowerShell lifecycle edges", () => {
  it.each(["&", "."])(
    "fails closed for an adjacent calculated %s invocation target",
    (operator) => {
      const inline = `${operator}("open" + "claw") gateway restart`;
      const command = `powershell -Command '${inline}'`;
      expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(true);
    },
  );

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

  it("keeps the Node-hosted identity selected by a claw-only negative filter", () => {
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
    ).toBe(true);
  });

  it("allows a negative filter only when it excludes every host identity", () => {
    const command = "Get-Process | Where-Object ProcessName -NotLike '*' | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "ProcessName",
        "-NotLike",
        "*",
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

  it("resolves environment-backed PowerShell alias targets", () => {
    const command = "Set-Alias oc $env:TOOL; oc gateway restart";
    expect(requiresApproval(command, ["oc", "gateway", "restart"], { TOOL: "openclaw" })).toBe(
      true,
    );
    expect(requiresApproval(command, ["oc", "gateway", "restart"], { TOOL: "git" })).toBe(false);
  });

  it("fails closed for unresolved PowerShell alias targets", () => {
    const command = "Set-Alias oc $env:TOOL; oc gateway restart";
    expect(requiresApproval(command, ["oc", "gateway", "restart"], {}, false)).toBe(true);
  });
});
