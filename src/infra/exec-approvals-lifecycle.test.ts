import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(command: string, argv: string[]): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    segments: [{ raw: command, argv }],
  });
}

const mutationCases: Array<[string, string[]]> = [
  ["openclaw gateway restart", ["openclaw", "gateway", "restart"]],
  ["openclaw gateway", ["openclaw", "gateway"]],
  ["openclaw gateway --token secret", ["openclaw", "gateway", "--token", "secret"]],
  ["openclaw daemon stop", ["openclaw", "daemon", "stop"]],
  ["openclaw gateway call update.run", ["openclaw", "gateway", "call", "update.run"]],
  ["openclaw update --yes", ["openclaw", "update", "--yes"]],
  ["openclaw uninstall --all --yes", ["openclaw", "uninstall", "--all", "--yes"]],
  ["openclaw onboard --install-daemon", ["openclaw", "onboard", "--install-daemon"]],
  [
    "launchctl stop gui/$UID/com.openclaw.gateway",
    ["launchctl", "stop", "gui/$UID/com.openclaw.gateway"],
  ],
  [
    "systemctl --user restart openclaw-gateway.service",
    ["systemctl", "--user", "restart", "openclaw-gateway.service"],
  ],
  ["service openclaw-gateway stop", ["service", "openclaw-gateway", "stop"]],
  ['schtasks /Run /TN "OpenClaw Gateway"', ["schtasks", "/Run", "/TN", "OpenClaw Gateway"]],
  ["pkill -TERM openclaw", ["pkill", "-TERM", "openclaw"]],
  ["kill -TERM $(pidof openclaw)", ["kill", "-TERM", "$(pidof openclaw)"]],
  [
    "sudo systemctl restart openclaw-gateway.service",
    ["sudo", "systemctl", "restart", "openclaw-gateway.service"],
  ],
  ["env -S 'openclaw gateway restart'", ["env", "-S", "openclaw gateway restart"]],
  ['sh -c "openclaw gateway restart"', ["sh", "-c", "openclaw gateway restart"]],
  [
    `sh -c 'openclaw gateway "$1"' sh restart`,
    ["sh", "-c", `openclaw gateway "$1"`, "sh", "restart"],
  ],
  ["npx openclaw@latest gateway restart", ["npx", "openclaw@latest", "gateway", "restart"]],
  [
    "npx -p openclaw openclaw gateway restart",
    ["npx", "-p", "openclaw", "openclaw", "gateway", "restart"],
  ],
  [
    "pnpm -C repo openclaw gateway restart",
    ["pnpm", "-C", "repo", "openclaw", "gateway", "restart"],
  ],
  [
    "node /opt/openclaw/dist/entry.js gateway restart",
    ["node", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
  ],
  [
    `powershell -NoProfile -Command "kill openclaw"`,
    ["powershell", "-NoProfile", "-Command", "kill openclaw"],
  ],
  ["Get-Process OpenClaw | Stop-Process", ["Get-Process", "OpenClaw", "|", "Stop-Process"]],
];

const nonMutationCases: Array<[string, string[]]> = [
  ["openclaw gateway status", ["openclaw", "gateway", "status"]],
  ["openclaw gateway --help", ["openclaw", "gateway", "--help"]],
  ["openclaw gateway call health", ["openclaw", "gateway", "call", "health"]],
  ["openclaw update status --json", ["openclaw", "update", "status", "--json"]],
  ["openclaw update --dry-run", ["openclaw", "update", "--dry-run"]],
  ["openclaw uninstall --dry-run", ["openclaw", "uninstall", "--dry-run"]],
  [
    "launchctl print gui/$UID/com.openclaw.gateway",
    ["launchctl", "print", "gui/$UID/com.openclaw.gateway"],
  ],
  [
    "systemctl --user status openclaw-gateway.service",
    ["systemctl", "--user", "status", "openclaw-gateway.service"],
  ],
  [
    "systemctl --signal=0 kill openclaw-gateway.service",
    ["systemctl", "--signal=0", "kill", "openclaw-gateway.service"],
  ],
  ['schtasks /Query /TN "OpenClaw Gateway"', ["schtasks", "/Query", "/TN", "OpenClaw Gateway"]],
  ["pidof openclaw", ["pidof", "openclaw"]],
  ["pkill -0 openclaw", ["pkill", "-0", "openclaw"]],
  ["echo openclaw gateway restart", ["echo", "openclaw", "gateway", "restart"]],
  [
    `echo 'Get-Service OpenClaw | Restart-Service'`,
    ["echo", "Get-Service OpenClaw | Restart-Service"],
  ],
];

describe("OpenClaw lifecycle exec approvals", () => {
  it.each(mutationCases)("requires explicit approval for %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it.each(nonMutationCases)(
    "keeps read-only or non-executing command non-blocking: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(false);
    },
  );

  it("uses the resolved executable identity", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "oc gateway restart",
        segments: [
          {
            raw: "oc gateway restart",
            argv: ["oc", "gateway", "restart"],
            resolution: {
              execution: {
                rawExecutable: "oc",
                executableName: "openclaw",
                resolvedPath: "/opt/bin/openclaw",
              },
              policy: {
                rawExecutable: "oc",
                executableName: "openclaw",
                resolvedPath: "/opt/bin/openclaw",
              },
              effectiveArgv: ["oc", "gateway", "restart"],
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
