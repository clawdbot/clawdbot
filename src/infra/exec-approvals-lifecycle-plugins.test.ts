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
    [
      "openclaw plugins --directory list install memory",
      ["openclaw", "plugins", "--directory", "list", "install", "memory"],
    ],
    [
      "openclaw plugins --directory=list install memory",
      ["openclaw", "plugins", "--directory=list", "install", "memory"],
    ],
    [
      "openclaw hooks --event list install ./pack",
      ["openclaw", "hooks", "--event", "list", "install", "./pack"],
    ],
    [
      "openclaw hooks --event=list install ./pack",
      ["openclaw", "hooks", "--event=list", "install", "./pack"],
    ],
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
    [
      "Get-Process | Where-Object ProcessName -Like '*claw*' | Stop-Process",
      ["Get-Process", "|", "Where-Object", "ProcessName", "-Like", "*claw*", "|", "Stop-Process"],
    ],
  ] as Array<[string, string[]]>)("classifies filtered mutation: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it("recognizes the Node-hosted OpenClaw process identity", () => {
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
    ).toBe(true);
  });
});

describe("OpenClaw launchd label approvals", () => {
  it.each([
    [
      "launchctl unload ~/Library/LaunchAgents/ai.open?law.gateway.plist",
      ["launchctl", "unload", "~/Library/LaunchAgents/ai.open?law.gateway.plist"],
    ],
    [
      "launchctl bootout gui/$UID/ai.open?law.work",
      ["launchctl", "bootout", "gui/$UID/ai.open?law.work"],
    ],
  ] as Array<[string, string[]]>)("recognizes current launchd label glob: %s", (command, argv) => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        platform: "darwin",
        segments: [{ raw: command, argv }],
      }),
    ).toBe(true);
  });
});

describe("OpenClaw lifecycle runner parsing edges", () => {
  it("recognizes the Windows PowerShell shim", () => {
    const shim = String.raw`C:\Users\Alice\AppData\Roaming\npm\openclaw.ps1`;
    expect(requiresApproval(`& ${shim} gateway restart`, ["&", shim, "gateway", "restart"])).toBe(
      true,
    );
  });

  it("fails closed for regexes matching OpenClaw entry process forms", () => {
    expect(
      requiresApproval(String.raw`pkill -f 'open[c]law\.mjs'`, [
        "pkill",
        "-f",
        String.raw`open[c]law\.mjs`,
      ]),
    ).toBe(true);
    expect(
      requiresApproval(String.raw`pkill -f 'node.*other\.mjs'`, [
        "pkill",
        "-f",
        String.raw`node.*other\.mjs`,
      ]),
    ).toBe(false);
  });

  it("recognizes the Windows Node image as an OpenClaw process candidate", () => {
    expect(
      requiresApproval("taskkill /IM node.exe /F", ["taskkill", "/IM", "node.exe", "/F"]),
    ).toBe(true);
  });

  it("does not execute unsafe process-selector regexes", () => {
    expect(
      requiresApproval(String.raw`pkill -f '^([A-Za-z0-9 /._:]+)+Z$'`, [
        "pkill",
        "-f",
        String.raw`^([A-Za-z0-9 /._:]+)+Z$`,
      ]),
    ).toBe(true);
  });

  it("expands embedded POSIX array positionals conservatively", () => {
    expect(
      requiresApproval(`sh -c 'open$@ gateway restart' sh claw`, [
        "sh",
        "-c",
        "open$@ gateway restart",
        "sh",
        "claw",
      ]),
    ).toBe(true);
  });

  it("honors negated dry-run options in argument order", () => {
    expect(
      requiresApproval("npm install --dry-run --no-dry-run openclaw", [
        "npm",
        "install",
        "--dry-run",
        "--no-dry-run",
        "openclaw",
      ]),
    ).toBe(true);
  });

  it("keeps option-terminated policy operands mutating", () => {
    expect(
      requiresApproval("openclaw approvals allowlist add -- --help", [
        "openclaw",
        "approvals",
        "allowlist",
        "add",
        "--",
        "--help",
      ]),
    ).toBe(true);
  });

  it.each([
    "plugins.install",
    "plugins.setEnabled",
    "plugins.uninstall",
    "plugins.refresh",
    "gateway.suspend.prepare",
    "gateway.suspend.resume",
  ])("classifies lifecycle gateway RPC: %s", (method) => {
    expect(
      requiresApproval(`openclaw gateway call ${method} --params '{}'`, [
        "openclaw",
        "gateway",
        "call",
        method,
        "--params",
        "{}",
      ]),
    ).toBe(true);
  });

  it("keeps read-only plugin gateway RPCs non-blocking", () => {
    expect(
      requiresApproval("openclaw gateway call plugins.list", [
        "openclaw",
        "gateway",
        "call",
        "plugins.list",
      ]),
    ).toBe(false);
  });

  it.each([
    ["& { openclaw gateway restart }", ["&", "{", "openclaw", "gateway", "restart", "}"]],
    [
      "if ($true) { openclaw gateway restart }",
      ["if", "($true)", "{", "openclaw", "gateway", "restart", "}"],
    ],
    ["if 1==1 openclaw gateway restart", ["if", "1==1", "openclaw", "gateway", "restart"]],
    [
      "if not exist nowhere openclaw gateway restart",
      ["if", "not", "exist", "nowhere", "openclaw", "gateway", "restart"],
    ],
    ["try { openclaw gateway restart }", ["try", "{", "openclaw", "gateway", "restart", "}"]],
  ] as Array<[string, string[]]>)("classifies shell control block: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it.each(["bun", "corepack", "pnpx", "yarnpkg"])(
    "fails closed when xargs appends stdin to %s",
    (runner) => {
      expect(requiresApproval(`xargs ${runner}`, ["xargs", runner])).toBe(true);
    },
  );

  it("classifies Node package-script run mode", () => {
    expect(
      requiresApproval("node --run openclaw -- gateway restart", [
        "node",
        "--run",
        "openclaw",
        "--",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("node --run=openclaw -- gateway restart", [
        "node",
        "--run=openclaw",
        "--",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("node --run build -- gateway restart", [
        "node",
        "--run",
        "build",
        "--",
        "gateway",
        "restart",
      ]),
    ).toBe(false);
  });

  it("classifies directly executable OpenClaw entry scripts", () => {
    expect(
      requiresApproval("/opt/openclaw/dist/entry.js gateway restart", [
        "/opt/openclaw/dist/entry.js",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("/opt/other/dist/entry.js gateway restart", [
        "/opt/other/dist/entry.js",
        "gateway",
        "restart",
      ]),
    ).toBe(false);
  });

  it.each(["run", "run-script", "rum", "urn"])("unwraps npm %s OpenClaw scripts", (subcommand) => {
    const command = `npm ${subcommand} openclaw -- gateway restart`;
    expect(
      requiresApproval(command, ["npm", subcommand, "openclaw", "--", "gateway", "restart"]),
    ).toBe(true);
  });

  it("keeps unrelated npm scripts non-blocking", () => {
    expect(
      requiresApproval("npm run build -- gateway restart", [
        "npm",
        "run",
        "build",
        "--",
        "gateway",
        "restart",
      ]),
    ).toBe(false);
  });

  it("fails closed before unwrapping ambiguous Yarn options", () => {
    const command = "yarn --mutex network run openclaw gateway restart";
    expect(
      requiresApproval(command, [
        "yarn",
        "--mutex",
        "network",
        "run",
        "openclaw",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
  });

  it("unwraps npx --shell before classifying the package target", () => {
    const command = "npx --shell /bin/sh openclaw gateway restart";
    expect(
      requiresApproval(command, ["npx", "--shell", "/bin/sh", "openclaw", "gateway", "restart"]),
    ).toBe(true);
  });

  it("preserves PowerShell Start-Process ArgumentList arrays", () => {
    const command =
      'Start-Process openclaw -ArgumentList "plugins", "install", "memory" -WorkingDirectory C:\\tmp';
    expect(
      requiresApproval(command, [
        "Start-Process",
        "openclaw",
        "-ArgumentList",
        "plugins,",
        "install,",
        "memory",
        "-WorkingDirectory",
        "C:\\tmp",
      ]),
    ).toBe(true);
  });

  it("keeps read-only Start-Process ArgumentList arrays non-blocking", () => {
    const command = 'Start-Process openclaw -ArgumentList "plugins", "list"';
    expect(
      requiresApproval(command, ["Start-Process", "openclaw", "-ArgumentList", "plugins,", "list"]),
    ).toBe(false);
  });

  it("treats only effective Start-Process WhatIf as non-executing", () => {
    const argv = ["Start-Process", "openclaw", "-ArgumentList", "gateway,", "restart"];
    expect(
      requiresApproval("Start-Process openclaw -ArgumentList 'gateway','restart' -WhatIf", [
        ...argv,
        "-WhatIf",
      ]),
    ).toBe(false);
    expect(
      requiresApproval("Start-Process openclaw -ArgumentList 'gateway','restart' -WhatIf:$false", [
        ...argv,
        "-WhatIf:$false",
      ]),
    ).toBe(true);
  });

  it("does not parse PowerShell backtick escapes as command substitutions", () => {
    expect(
      requiresApproval("Write-Output `openclaw gateway restart`x", [
        "Write-Output",
        "`openclaw",
        "gateway",
        "restart`x",
      ]),
    ).toBe(false);
    expect(
      requiresApproval("Write-Output `$(openclaw gateway restart)", [
        "Write-Output",
        "`$(openclaw gateway restart)",
      ]),
    ).toBe(false);
    expect(
      requiresApproval("Write-Output \\$(openclaw gateway restart)", [
        "Write-Output",
        "\\$(openclaw gateway restart)",
      ]),
    ).toBe(true);
  });
});

describe("OpenClaw lifecycle substitution-controlled options", () => {
  it.each([
    [`pkill "$(printf 'open%sclaw' '')"`, ["pkill", "$(printf 'open%sclaw' '')"]],
    [
      `bun "$(printf x)" openclaw gateway restart`,
      ["bun", "$(printf x)", "openclaw", "gateway", "restart"],
    ],
    [
      `Start-Process "$(printf openclaw)" -ArgumentList "gateway", "restart"`,
      ["Start-Process", "$(printf openclaw)", "-ArgumentList", "gateway,", "restart"],
    ],
  ] as Array<[string, string[]]>)(
    "fails closed for dynamic process or runner target: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    [
      `openclaw doctor --session-sqlite "$(printf compact)"`,
      ["openclaw", "doctor", "--session-sqlite", "$(printf compact)"],
    ],
    [
      `openclaw doctor --state-sqlite="$(printf compact)"`,
      ["openclaw", "doctor", "--state-sqlite=$(printf compact)"],
    ],
  ] as Array<[string, string[]]>)(
    "fails closed for dynamic doctor maintenance value: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it("ignores substitutions confined to unrelated package-manager option values", () => {
    expect(
      requiresApproval('npm install lodash --registry="$(get-registry)"', [
        "npm",
        "install",
        "lodash",
        "--registry=$(get-registry)",
      ]),
    ).toBe(false);
    expect(
      requiresApproval('npm install "$(get-package)"', ["npm", "install", "$(get-package)"]),
    ).toBe(true);
  });

  it.each([
    [
      'openclaw update --dry-run="$(printf false)"',
      ["openclaw", "update", "--dry-run=$(printf false)"],
    ],
    [
      'openclaw config set gateway.port 19001 --dry-run="$(printf false)"',
      ["openclaw", "config", "set", "gateway.port", "19001", "--dry-run=$(printf false)"],
    ],
    [
      'openclaw reset --dry-run="$(printf false)"',
      ["openclaw", "reset", "--dry-run=$(printf false)"],
    ],
    [
      'openclaw plugins update memory --dry-run="$(printf false)"',
      ["openclaw", "plugins", "update", "memory", "--dry-run=$(printf false)"],
    ],
    [
      'openclaw hooks update audit --dry-run="$(printf false)"',
      ["openclaw", "hooks", "update", "audit", "--dry-run=$(printf false)"],
    ],
  ] as Array<[string, string[]]>)(
    "fails closed for dynamic preview option: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it("fails closed for a substitution-generated plugin registry refresh", () => {
    const command = 'openclaw plugins registry "$(printf -- --refresh)"';
    expect(
      requiresApproval(command, ["openclaw", "plugins", "registry", "$(printf -- --refresh)"]),
    ).toBe(true);
  });
});
