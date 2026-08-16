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

  it("fails closed for calculated invocations inside control blocks", () => {
    const inline = `if ($true) { & ("open" + "claw") gateway restart }`;
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(true);
  });

  it("fails closed when PowerShell composes the target and lifecycle arguments", () => {
    const inline = `& ("open" + "claw") ("gate" + "way") ("re" + "start")`;
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(true);
  });

  it("fails closed when PowerShell composes direct lifecycle arguments", () => {
    const inline = `openclaw ("gate" + "way") ("re" + "start")`;
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(true);
  });

  it("keeps calculated arguments to a static read-only command non-blocking", () => {
    const inline = `openclaw status ("f" + "oo")`;
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(false);
  });

  it("keeps a calculated target with static non-lifecycle arguments non-blocking", () => {
    const inline = `& ("git") status`;
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(false);
  });

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

  it("keeps OpenClaw selected by a compound positive filter", () => {
    const command =
      "Get-Process | Where-Object { $_.ProcessName -Like 'notepad' -or $true } | Stop-Process";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "|",
        "Where-Object",
        "{",
        "$_.ProcessName",
        "-Like",
        "notepad",
        "-or",
        "$true",
        "}",
        "|",
        "Stop-Process",
      ]),
    ).toBe(true);
  });

  it("honors only an effective PowerShell WhatIf preview", () => {
    expect(
      requiresApproval("Stop-Process -Name OpenClaw -WhatIf", [
        "Stop-Process",
        "-Name",
        "OpenClaw",
        "-WhatIf",
      ]),
    ).toBe(false);
    expect(
      requiresApproval("Stop-Process -Name OpenClaw -WhatIf:$false", [
        "Stop-Process",
        "-Name",
        "OpenClaw",
        "-WhatIf:$false",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("Get-Service OpenClaw | Restart-Service -WhatIf", [
        "Get-Service",
        "OpenClaw",
        "|",
        "Restart-Service",
        "-WhatIf",
      ]),
    ).toBe(false);
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

  it.each([
    [
      "Get-Process OpenClaw | ForEach-Object { $_.Kill() }",
      ["Get-Process", "OpenClaw", "|", "ForEach-Object", "{", "$_.Kill()", "}"],
    ],
    [
      "Get-Service OpenClaw | % { $_.Stop() }",
      ["Get-Service", "OpenClaw", "|", "%", "{", "$_.Stop()", "}"],
    ],
  ] as Array<[string, string[]]>)(
    "recognizes pipeline object lifecycle methods: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    ["(Get-Process OpenClaw).Kill()", ["(Get-Process", "OpenClaw).Kill()"]],
    ["(Get-Service OpenClaw).Stop()", ["(Get-Service", "OpenClaw).Stop()"]],
    ["(Get-Process node).Kill()", ["(Get-Process", "node).Kill()"]],
  ] as Array<[string, string[]]>)(
    "recognizes direct object lifecycle methods: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it("keeps direct read-only object methods non-blocking", () => {
    const command = "(Get-Process OpenClaw).Refresh()";
    expect(requiresApproval(command, ["(Get-Process", "OpenClaw).Refresh()"])).toBe(false);
  });

  it("keeps non-mutating pipeline object methods non-blocking", () => {
    const command = "Get-Process OpenClaw | ForEach-Object { $_.Refresh() }";
    expect(
      requiresApproval(command, [
        "Get-Process",
        "OpenClaw",
        "|",
        "ForEach-Object",
        "{",
        "$_.Refresh()",
        "}",
      ]),
    ).toBe(false);
  });

  it("recursively classifies OpenClaw commands in pipeline script blocks", () => {
    const inline = "1 | % { openclaw gateway restart }";
    const command = `powershell -Command '${inline}'`;
    expect(requiresApproval(command, ["powershell", "-Command", inline])).toBe(true);
    expect(
      requiresApproval("powershell -Command '1 | % { openclaw status }'", [
        "powershell",
        "-Command",
        "1 | % { openclaw status }",
      ]),
    ).toBe(false);
  });

  it("classifies executable script-block parameters without a pipeline", () => {
    const command = "ForEach-Object -InputObject 1 -Process { openclaw gateway restart }";
    expect(
      requiresApproval(command, [
        "ForEach-Object",
        "-InputObject",
        "1",
        "-Process",
        "{",
        "openclaw",
        "gateway",
        "restart",
        "}",
      ]),
    ).toBe(true);
  });

  it("does not execute PowerShell hashtable literals", () => {
    const command = "Write-Output @{ Command = 'openclaw gateway restart' }";
    expect(requiresApproval(command, ["Write-Output", "@{", "Command", "=", "openclaw", "}"])).toBe(
      false,
    );
  });

  it("tracks OpenClaw aliases across PowerShell fragments", () => {
    const command = "Set-Alias oc openclaw; oc exec-policy preset yolo";
    expect(requiresApproval(command, ["oc", "exec-policy", "preset", "yolo"])).toBe(false);
    expect(requiresApproval("Set-Alias oc openclaw; oc status", ["oc", "status"])).toBe(false);
  });

  it.each([
    ["Set-Alias nx npx; nx openclaw gateway restart", ["nx", "openclaw", "gateway", "restart"]],
    ["Set-Alias zap Stop-Process; zap -Name OpenClaw", ["zap", "-Name", "OpenClaw"]],
    ["& Set-Alias oc openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
    ["if ($true) { Set-Alias oc openclaw }; oc gateway restart", ["oc", "gateway", "restart"]],
    [
      "Set-Alias sp Start-Process; sp openclaw -ArgumentList gateway,restart",
      ["sp", "openclaw", "-ArgumentList", "gateway,restart"],
    ],
  ] as Array<[string, string[]]>)(
    "tracks PowerShell aliases to command carriers: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    ["Set-Item Alias:oc openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
    ["New-Item Alias:oc -Value openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
    ["Set-Item -Path Alias:oc openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
  ] as Array<[string, string[]]>)(
    "tracks aliases created through the Alias provider: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    ["Set-Alias -ErrorAction Stop oc openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
    ["Set-Alias -EA Stop oc openclaw; oc gateway restart", ["oc", "gateway", "restart"]],
    [
      "Start-Process -ErrorAction Stop openclaw -ArgumentList gateway,restart",
      ["Start-Process", "-ErrorAction", "Stop", "openclaw", "-ArgumentList", "gateway,restart"],
    ],
    [
      "Start-Process -EA Stop openclaw -ArgumentList gateway,restart",
      ["Start-Process", "-EA", "Stop", "openclaw", "-ArgumentList", "gateway,restart"],
    ],
  ] as Array<[string, string[]]>)(
    "consumes PowerShell common-parameter values: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

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

  it.each([
    ["exec-policy", "preset", "yolo"],
    ["config", "set", "gateway.port", "19001"],
    ["reset", "--yes"],
  ])(
    "keeps unresolved non-lifecycle Start-Process arguments outside the boundary: %s",
    (...args) => {
      const command = `Start-Process $env:TOOL -ArgumentList '${args.join("','")}'`;
      expect(
        requiresApproval(
          command,
          ["Start-Process", "$env:TOOL", "-ArgumentList", args.join(",")],
          {},
          false,
        ),
      ).toBe(false);
    },
  );

  it.each([
    [
      "openclaw onboard --install-daemon --help",
      ["openclaw", "onboard", "--install-daemon", "--help"],
    ],
    [
      "openclaw configure --section channels --help",
      ["openclaw", "configure", "--section", "channels", "--help"],
    ],
    ["openclaw setup --wizard --help", ["openclaw", "setup", "--wizard", "--help"]],
    ["openclaw node --help restart", ["openclaw", "node", "--help", "restart"]],
  ] as Array<[string, string[]]>)(
    "keeps help-only lifecycle-shaped commands non-blocking: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(false);
    },
  );
});
