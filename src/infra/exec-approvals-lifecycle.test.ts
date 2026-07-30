import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(command: string, argv: string[]): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    segments: [{ raw: command, argv }],
  });
}

function nestShellSubstitution(command: string, depth: number): string {
  let nested = command;
  for (let index = 0; index < depth; index += 1) {
    nested = `echo "$(${nested})"`;
  }
  return nested;
}

const mutationCases: Array<[string, string[]]> = [
  ["openclaw gateway restart", ["openclaw", "gateway", "restart"]],
  ["openclaw gateway", ["openclaw", "gateway"]],
  ["openclaw gateway --token secret", ["openclaw", "gateway", "--token", "secret"]],
  ["openclaw daemon stop", ["openclaw", "daemon", "stop"]],
  ["/usr/bin/opencla? gateway restart", ["/usr/bin/opencla?", "gateway", "restart"]],
  ["openclaw gateway call update.run", ["openclaw", "gateway", "call", "update.run"]],
  [
    "openclaw gateway call --url ws://127.0.0.1:18789 update.run",
    ["openclaw", "gateway", "call", "--url", "ws://127.0.0.1:18789", "update.run"],
  ],
  ["openclaw gateway call config.apply", ["openclaw", "gateway", "call", "config.apply"]],
  ["openclaw update --yes", ["openclaw", "update", "--yes"]],
  ["openclaw uninstall --all --yes", ["openclaw", "uninstall", "--all", "--yes"]],
  ["openclaw onboard --install-daemon", ["openclaw", "onboard", "--install-daemon"]],
  [
    "launchctl stop gui/$UID/com.openclaw.gateway",
    ["launchctl", "stop", "gui/$UID/com.openclaw.gateway"],
  ],
  [
    "launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist",
    ["launchctl", "unload", "~/Library/LaunchAgents/com.openclaw.gateway.plist"],
  ],
  [
    "launchctl asuser 501 openclaw gateway restart",
    ["launchctl", "asuser", "501", "openclaw", "gateway", "restart"],
  ],
  [
    "launchctl bsexec 123 openclaw gateway restart",
    ["launchctl", "bsexec", "123", "openclaw", "gateway", "restart"],
  ],
  [
    "systemctl --user restart openclaw-gateway.service",
    ["systemctl", "--user", "restart", "openclaw-gateway.service"],
  ],
  [
    "systemctl -H host restart openclaw-gateway.service",
    ["systemctl", "-H", "host", "restart", "openclaw-gateway.service"],
  ],
  [
    "systemctl --job-mode replace restart openclaw-gateway.service",
    ["systemctl", "--job-mode", "replace", "restart", "openclaw-gateway.service"],
  ],
  [
    "systemctl $(printf restart) openclaw-gateway.service",
    ["systemctl", "$(printf restart)", "openclaw-gateway.service"],
  ],
  [
    "systemctl restart openclaw-gateway.service -- --help",
    ["systemctl", "restart", "openclaw-gateway.service", "--", "--help"],
  ],
  [
    "systemctl kill openclaw-gateway.service -- --signal=0",
    ["systemctl", "kill", "openclaw-gateway.service", "--", "--signal=0"],
  ],
  [
    "systemctl --signal=0 --signal=TERM kill openclaw-gateway.service",
    ["systemctl", "--signal=0", "--signal=TERM", "kill", "openclaw-gateway.service"],
  ],
  ["service openclaw-gateway stop", ["service", "openclaw-gateway", "stop"]],
  [
    String.raw`sc.exe \\localhost delete OpenClaw`,
    ["sc.exe", String.raw`\\localhost`, "delete", "OpenClaw"],
  ],
  ['schtasks /Run /TN "OpenClaw Gateway"', ["schtasks", "/Run", "/TN", "OpenClaw Gateway"]],
  ["pkill -TERM openclaw", ["pkill", "-TERM", "openclaw"]],
  ["kill -TERM $(pidof openclaw)", ["kill", "-TERM", "$(pidof openclaw)"]],
  [
    "kill $(systemctl show --property MainPID --value openclaw-gateway.service)",
    ["kill", "$(systemctl show --property MainPID --value openclaw-gateway.service)"],
  ],
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
  [
    `sh -c 'openclaw $1' sh 'gateway restart'`,
    ["sh", "-c", "openclaw $1", "sh", "gateway restart"],
  ],
  ["npx openclaw@latest gateway restart", ["npx", "openclaw@latest", "gateway", "restart"]],
  [
    "npx --color always openclaw gateway restart",
    ["npx", "--color", "always", "openclaw", "gateway", "restart"],
  ],
  [
    "npx -p openclaw openclaw gateway restart",
    ["npx", "-p", "openclaw", "openclaw", "gateway", "restart"],
  ],
  [`npx -c "openclaw gateway restart"`, ["npx", "-c", "openclaw gateway restart"]],
  ["npm exec -- openclaw gateway restart", ["npm", "exec", "--", "openclaw", "gateway", "restart"]],
  ["npm install -g openclaw@latest", ["npm", "install", "-g", "openclaw@latest"]],
  ["npm install -g oc@npm:openclaw@latest", ["npm", "install", "-g", "oc@npm:openclaw@latest"]],
  ["npm rm -g openclaw", ["npm", "rm", "-g", "openclaw"]],
  ["npm r -g openclaw", ["npm", "r", "-g", "openclaw"]],
  ["npm unlink -g openclaw", ["npm", "unlink", "-g", "openclaw"]],
  ["pnpm un openclaw", ["pnpm", "un", "openclaw"]],
  ["yarn upgrade openclaw", ["yarn", "upgrade", "openclaw"]],
  ["yarn global add openclaw", ["yarn", "global", "add", "openclaw"]],
  ["yarn global remove openclaw", ["yarn", "global", "remove", "openclaw"]],
  [
    "npm --prefix /tmp exec -- openclaw gateway restart",
    ["npm", "--prefix", "/tmp", "exec", "--", "openclaw", "gateway", "restart"],
  ],
  [
    "pnpm -C repo dlx openclaw gateway restart",
    ["pnpm", "-C", "repo", "dlx", "openclaw", "gateway", "restart"],
  ],
  ["yarn dlx openclaw gateway restart", ["yarn", "dlx", "openclaw", "gateway", "restart"]],
  [
    "pnpm -C repo openclaw gateway restart",
    ["pnpm", "-C", "repo", "openclaw", "gateway", "restart"],
  ],
  [
    "node /opt/openclaw/dist/entry.js gateway restart",
    ["node", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
  ],
  [
    "node -r preload /opt/openclaw/dist/entry.js gateway restart",
    ["node", "-r", "preload", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
  ],
  [
    "node -rpreload /opt/openclaw/dist/entry.js gateway restart",
    ["node", "-rpreload", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
  ],
  [
    "node --experimental_loader ./loader.mjs /opt/openclaw/dist/entry.js gateway restart",
    [
      "node",
      "--experimental_loader",
      "./loader.mjs",
      "/opt/openclaw/dist/entry.js",
      "gateway",
      "restart",
    ],
  ],
  [
    `powershell -NoProfile -Command "kill openclaw"`,
    ["powershell", "-NoProfile", "-Command", "kill openclaw"],
  ],
  ["Get-Process OpenClaw | Stop-Process", ["Get-Process", "OpenClaw", "|", "Stop-Process"]],
  ["Get-Service OpenClaw | Start-Service", ["Get-Service", "OpenClaw", "|", "Start-Service"]],
  ["Get-Service OpenClaw | Remove-Service", ["Get-Service", "OpenClaw", "|", "Remove-Service"]],
  [
    "Get-Service OpenClaw | Set-Service -StartupType Disabled",
    ["Get-Service", "OpenClaw", "|", "Set-Service", "-StartupType", "Disabled"],
  ],
  ["Get-Process OpenClaw | kill", ["Get-Process", "OpenClaw", "|", "kill"]],
  ["ps OpenClaw | kill", ["ps", "OpenClaw", "|", "kill"]],
  [
    "env env env env env env env env openclaw gateway restart",
    ["env", "env", "env", "env", "env", "env", "env", "env", "openclaw", "gateway", "restart"],
  ],
  ["xargs openclaw gateway", ["xargs", "openclaw", "gateway"]],
  ["printf 'gateway restart' | xargs openclaw", ["xargs", "openclaw"]],
  ["printf 'gateway' | xargs -I{} openclaw {}", ["xargs", "-I{}", "openclaw", "{}"]],
  ["pgrep openclaw | xargs kill", ["xargs", "kill"]],
  ["pgrep openclaw | xargs --no-run-if-empty kill", ["xargs", "--no-run-if-empty", "kill"]],
  ["xargs -I{} {} gateway restart", ["xargs", "-I{}", "{}", "gateway", "restart"]],
  ["xargs -I{} env {} gateway restart", ["xargs", "-I{}", "env", "{}", "gateway", "restart"]],
  [
    "xargs env -a '' openclaw gateway restart",
    ["xargs", "env", "-a", "", "openclaw", "gateway", "restart"],
  ],
  ["$(printf openclaw) gateway restart", ["$(printf openclaw)", "gateway", "restart"]],
  [`echo "$(openclaw gateway restart)"`, ["echo", "$(openclaw gateway restart)"]],
  [
    String.raw`echo "$(printf '\'; openclaw gateway restart)"`,
    ["echo", String.raw`$(printf '\'; openclaw gateway restart)`],
  ],
  ["echo `openclaw gateway restart`", ["echo", "openclaw gateway restart"]],
  [nestShellSubstitution("openclaw gateway restart", 9), ["echo", "nested substitution"]],
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
    "systemctl -h restart openclaw-gateway.service",
    ["systemctl", "-h", "restart", "openclaw-gateway.service"],
  ],
  [
    "systemctl --signal=0 kill openclaw-gateway.service",
    ["systemctl", "--signal=0", "kill", "openclaw-gateway.service"],
  ],
  ['schtasks /Query /TN "OpenClaw Gateway"', ["schtasks", "/Query", "/TN", "OpenClaw Gateway"]],
  ["pidof openclaw", ["pidof", "openclaw"]],
  ["pkill -0 openclaw", ["pkill", "-0", "openclaw"]],
  ["kill -s 0 $(pidof openclaw)", ["kill", "-s", "0", "$(pidof openclaw)"]],
  ["kill --signal 0 $(pidof openclaw)", ["kill", "--signal", "0", "$(pidof openclaw)"]],
  ["echo openclaw gateway restart", ["echo", "openclaw", "gateway", "restart"]],
  [
    `echo 'Get-Service OpenClaw | Restart-Service'`,
    ["echo", "Get-Service OpenClaw | Restart-Service"],
  ],
  [`echo '$(openclaw gateway restart)'`, ["echo", "$(openclaw gateway restart)"]],
  ["echo $(date)", ["echo", "$(date)"]],
  ["systemctl status $(hostname)", ["systemctl", "status", "$(hostname)"]],
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

  it("uses resolved lifecycle utility identities", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "ctl --user restart openclaw-gateway.service",
        segments: [
          {
            raw: "ctl --user restart openclaw-gateway.service",
            argv: ["ctl", "--user", "restart", "openclaw-gateway.service"],
            resolution: {
              execution: {
                rawExecutable: "ctl",
                executableName: "systemctl",
                resolvedPath: "/usr/bin/systemctl",
              },
              policy: {
                rawExecutable: "ctl",
                executableName: "systemctl",
                resolvedPath: "/usr/bin/systemctl",
              },
              effectiveArgv: ["ctl", "--user", "restart", "openclaw-gateway.service"],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("expands known lifecycle environment references", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `systemctl "$ACTION" "$SERVICE"`,
        env: {
          ACTION: "restart",
          SERVICE: "openclaw-gateway.service",
        },
        segments: [
          {
            raw: `systemctl "$ACTION" "$SERVICE"`,
            argv: ["systemctl", "$ACTION", "$SERVICE"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed for partial lifecycle environments", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `systemctl "$ACTION" openclaw-gateway.service`,
        env: {},
        envComplete: false,
        segments: [
          {
            raw: `systemctl "$ACTION" openclaw-gateway.service`,
            argv: ["systemctl", "$ACTION", "openclaw-gateway.service"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed when a partial environment controls the executable", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "$TOOL gateway restart",
        env: {},
        envComplete: false,
        segments: [
          {
            raw: "$TOOL gateway restart",
            argv: ["$TOOL", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed when a parameter operator supplies the executable", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "${TOOL:-openclaw} gateway restart",
        env: {},
        segments: [
          {
            raw: "${TOOL:-openclaw} gateway restart",
            argv: ["${TOOL:-openclaw}", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed when known environment expansion may field-split lifecycle argv", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "systemctl $ARGS",
        env: { ARGS: "restart openclaw-gateway.service" },
        segments: [
          {
            raw: "systemctl $ARGS",
            argv: ["systemctl", "$ARGS"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed when a partial environment supplies a wrapper payload", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `sh -c "$SCRIPT"`,
        env: {},
        envComplete: false,
        segments: [
          {
            raw: `sh -c "$SCRIPT"`,
            argv: ["sh", "-c", "$SCRIPT"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not let a later status token clear an unresolved systemctl action", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "systemctl $ACTION status openclaw-gateway.service",
        env: {},
        envComplete: false,
        segments: [
          {
            raw: "systemctl $ACTION status openclaw-gateway.service",
            argv: ["systemctl", "$ACTION", "status", "openclaw-gateway.service"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps partial read-only service inspection non-blocking", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `systemctl status "$SERVICE"`,
        env: {},
        envComplete: false,
        segments: [
          {
            raw: `systemctl status "$SERVICE"`,
            argv: ["systemctl", "status", "$SERVICE"],
          },
        ],
      }),
    ).toBe(false);
  });
});
