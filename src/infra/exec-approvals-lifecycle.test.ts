import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

function requiresApproval(
  command: string,
  argv: string[],
  platform: NodeJS.Platform = "linux",
): boolean {
  return commandRequiresOpenClawLifecycleApproval({
    command,
    platform,
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

const classifiedCases: Array<[string, string[]]> = [
  ["openclaw gateway restart", ["openclaw", "gateway", "restart"]],
  ["./openclaw.mjs gateway restart", ["./openclaw.mjs", "gateway", "restart"]],
  ["./opencla?.mjs gateway restart", ["./opencla?.mjs", "gateway", "restart"]],
  ["openclaw gateway", ["openclaw", "gateway"]],
  ["openclaw gateway --token secret", ["openclaw", "gateway", "--token", "secret"]],
  ["openclaw gateway --token status", ["openclaw", "gateway", "--token", "status"]],
  ["openclaw gateway --token --help", ["openclaw", "gateway", "--token", "--help"]],
  ["openclaw gateway --password health", ["openclaw", "gateway", "--password", "health"]],
  [`openclaw gateway "$(printf restart)"`, ["openclaw", "gateway", "$(printf restart)"]],
  ["openclaw daemon stop", ["openclaw", "daemon", "stop"]],
  ["/usr/bin/opencla? gateway restart", ["/usr/bin/opencla?", "gateway", "restart"]],
  ["open{c..c}law gateway restart", ["open{c..c}law", "gateway", "restart"]],
  ["open{cla?,noop} gateway restart", ["open{cla?,noop}", "gateway", "restart"]],
  ["openclaw gateway call update.run", ["openclaw", "gateway", "call", "update.run"]],
  [
    "openclaw gateway call --url ws://127.0.0.1:18789 update.run",
    ["openclaw", "gateway", "call", "--url", "ws://127.0.0.1:18789", "update.run"],
  ],
  ["openclaw gateway call config.apply", ["openclaw", "gateway", "call", "config.apply"]],
  ["openclaw exec-policy preset yolo", ["openclaw", "exec-policy", "preset", "yolo"]],
  ["openclaw approvals set --stdin", ["openclaw", "approvals", "set", "--stdin"]],
  [
    "openclaw config set gateway.port 19001",
    ["openclaw", "config", "set", "gateway.port", "19001"],
  ],
  ["openclaw doctor --fix", ["openclaw", "doctor", "--fix"]],
  ["openclaw update --yes", ["openclaw", "update", "--yes"]],
  ["openclaw uninstall --all --yes", ["openclaw", "uninstall", "--all", "--yes"]],
  ["openclaw onboard --install-daemon", ["openclaw", "onboard", "--install-daemon"]],
  ["openclaw setup", ["openclaw", "setup"]],
  ["openclaw configure", ["openclaw", "configure"]],
  ["openclaw node install", ["openclaw", "node", "install"]],
  ["openclaw node start", ["openclaw", "node", "start"]],
  ["openclaw node restart", ["openclaw", "node", "restart"]],
  ["openclaw node stop", ["openclaw", "node", "stop"]],
  ["openclaw node uninstall", ["openclaw", "node", "uninstall"]],
  ["openclaw node run", ["openclaw", "node", "run"]],
  ["openclaw node --host example restart", ["openclaw", "node", "--host", "example", "restart"]],
  [
    "openclaw reset --scope full --yes --non-interactive",
    ["openclaw", "reset", "--scope", "full", "--yes", "--non-interactive"],
  ],
  [
    "openclaw gateway call update.run --params '{}' -- --help",
    ["openclaw", "gateway", "call", "update.run", "--params", "{}", "--", "--help"],
  ],
  [
    "openclaw uninstall --dry-run --dry-run=false",
    ["openclaw", "uninstall", "--dry-run", "--dry-run=false"],
  ],
  [
    "npm install --dry-run --dry-run=false openclaw",
    ["npm", "install", "--dry-run", "--dry-run=false", "openclaw"],
  ],
  [
    "launchctl stop gui/$UID/com.openclaw.gateway",
    ["launchctl", "stop", "gui/$UID/com.openclaw.gateway"],
  ],
  [
    "launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist",
    ["launchctl", "unload", "~/Library/LaunchAgents/com.openclaw.gateway.plist"],
  ],
  ["launchctl unload '*claw*.plist'", ["launchctl", "unload", "*claw*.plist"]],
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
    "systemctl restart 'open*claw-gateway.service'",
    ["systemctl", "restart", "open*claw-gateway.service"],
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
    "systemctl add-wants multi-user.target openclaw-gateway.service",
    ["systemctl", "add-wants", "multi-user.target", "openclaw-gateway.service"],
  ],
  [
    "systemctl remove-requires multi-user.target openclaw-gateway.service",
    ["systemctl", "remove-requires", "multi-user.target", "openclaw-gateway.service"],
  ],
  [
    "systemctl force-reload openclaw-gateway.service",
    ["systemctl", "force-reload", "openclaw-gateway.service"],
  ],
  [
    "systemctl clean --what=state openclaw-gateway.service",
    ["systemctl", "clean", "--what=state", "openclaw-gateway.service"],
  ],
  [
    "systemctl -p --help restart openclaw-gateway.service",
    ["systemctl", "-p", "--help", "restart", "openclaw-gateway.service"],
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
  ["net pause OpenClaw", ["net", "pause", "OpenClaw"]],
  ["net continue OpenClaw", ["net", "continue", "OpenClaw"]],
  [
    String.raw`sc.exe \\localhost delete OpenClaw`,
    ["sc.exe", String.raw`\\localhost`, "delete", "OpenClaw"],
  ],
  [
    "sc.exe failure OpenClaw reset= 0 actions= restart/5000",
    ["sc.exe", "failure", "OpenClaw", "reset=", "0", "actions=", "restart/5000"],
  ],
  ["sc.exe failureflag OpenClaw 1", ["sc.exe", "failureflag", "OpenClaw", "1"]],
  ['schtasks /Run /TN "OpenClaw Gateway"', ["schtasks", "/Run", "/TN", "OpenClaw Gateway"]],
  ["taskkill /IM open*.exe", ["taskkill", "/IM", "open*.exe"]],
  ["pkill -TERM openclaw", ["pkill", "-TERM", "openclaw"]],
  ["pkill -f 'open.*claw'", ["pkill", "-f", "open.*claw"]],
  ["pkill -f 'open[[:alpha:]]law'", ["pkill", "-f", "open[[:alpha:]]law"]],
  ["kill -TERM $(pidof openclaw)", ["kill", "-TERM", "$(pidof openclaw)"]],
  [`kill "$(pidof open''claw)"`, ["kill", "$(pidof openclaw)"]],
  ["kill -TERM $(pgrep -f '[o]penclaw')", ["kill", "-TERM", "$(pgrep -f '[o]penclaw')"]],
  [`kill "$(pgrep -f 'open.*claw')"`, ["kill", "$(pgrep -f open.*claw)"]],
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
  ["sh -c 'X=1 openclaw gateway restart'", ["sh", "-c", "X=1 openclaw gateway restart"]],
  [
    "sh -c '(echo ok; openclaw gateway restart)'",
    ["sh", "-c", "(echo ok; openclaw gateway restart)"],
  ],
  [
    "sh -c '{ echo ok; openclaw gateway restart; }'",
    ["sh", "-c", "{ echo ok; openclaw gateway restart; }"],
  ],
  [
    "sh -c 'if true; then openclaw gateway restart; fi'",
    ["sh", "-c", "if true; then openclaw gateway restart; fi"],
  ],
  ["sh -c 'true ^; openclaw gateway restart'", ["sh", "-c", "true ^; openclaw gateway restart"]],
  [
    "sh -c 'f(){ openclaw gateway restart; }; f'",
    ["sh", "-c", "f(){ openclaw gateway restart; }; f"],
  ],
  [
    `sh -c 'openclaw gateway "$1"' sh restart`,
    ["sh", "-c", `openclaw gateway "$1"`, "sh", "restart"],
  ],
  [
    `sh -c 'openclaw $1' sh 'gateway restart'`,
    ["sh", "-c", "openclaw $1", "sh", "gateway restart"],
  ],
  [`sh -c '$0 restart' 'openclaw gateway'`, ["sh", "-c", "$0 restart", "openclaw gateway"]],
  [
    "sh -c '${1:-openclaw} gateway restart' sh",
    ["sh", "-c", "${1:-openclaw} gateway restart", "sh"],
  ],
  ["npx openclaw@latest gateway restart", ["npx", "openclaw@latest", "gateway", "restart"]],
  ["pnpx openclaw gateway restart", ["pnpx", "openclaw", "gateway", "restart"]],
  [
    "npx github:openclaw/openclaw#main gateway restart",
    ["npx", "github:openclaw/openclaw#main", "gateway", "restart"],
  ],
  [
    "npx oc@npm:openclaw@latest gateway restart",
    ["npx", "oc@npm:openclaw@latest", "gateway", "restart"],
  ],
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
  [
    "npm exec -- openclaw config set gateway.auth.token -- -c",
    ["npm", "exec", "--", "openclaw", "config", "set", "gateway.auth.token", "--", "-c"],
  ],
  ["npm install -g openclaw@latest", ["npm", "install", "-g", "openclaw@latest"]],
  ["npm install -p openclaw", ["npm", "install", "-p", "openclaw"]],
  ["npm rebuild openclaw", ["npm", "rebuild", "openclaw"]],
  ["npm it openclaw", ["npm", "it", "openclaw"]],
  ["npm install-test openclaw", ["npm", "install-test", "openclaw"]],
  ["pnpm rebuild openclaw", ["pnpm", "rebuild", "openclaw"]],
  ["npm --help=false install openclaw", ["npm", "--help=false", "install", "openclaw"]],
  ["npm --version=false install openclaw", ["npm", "--version=false", "install", "openclaw"]],
  [
    "npm --location global install openclaw",
    ["npm", "--location", "global", "install", "openclaw"],
  ],
  [
    "npm --future-option global install openclaw",
    ["npm", "--future-option", "global", "install", "openclaw"],
  ],
  [
    "npm install -g github:openclaw/openclaw#main",
    ["npm", "install", "-g", "github:openclaw/openclaw#main"],
  ],
  ["npm install -g file:../openclaw", ["npm", "install", "-g", "file:../openclaw"]],
  ["npm install -g oc@npm:openclaw@latest", ["npm", "install", "-g", "oc@npm:openclaw@latest"]],
  ["npm install --prefix /tmp openclaw", ["npm", "install", "--prefix", "/tmp", "openclaw"]],
  [
    "npm install --registry --help openclaw",
    ["npm", "install", "--registry", "--help", "openclaw"],
  ],
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
  [
    "corepack pnpm@latest dlx openclaw gateway restart",
    ["corepack", "pnpm@latest", "dlx", "openclaw", "gateway", "restart"],
  ],
  ["yarn dlx openclaw gateway restart", ["yarn", "dlx", "openclaw", "gateway", "restart"]],
  ["yarnpkg dlx openclaw gateway restart", ["yarnpkg", "dlx", "openclaw", "gateway", "restart"]],
  ["yarn run openclaw gateway restart", ["yarn", "run", "openclaw", "gateway", "restart"]],
  ["pnpm run openclaw gateway restart", ["pnpm", "run", "openclaw", "gateway", "restart"]],
  ["bun x openclaw gateway restart", ["bun", "x", "openclaw", "gateway", "restart"]],
  ["bun run openclaw gateway restart", ["bun", "run", "openclaw", "gateway", "restart"]],
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
    "node --loader ./loader.mjs /opt/openclaw/dist/entry.js gateway restart",
    ["node", "--loader", "./loader.mjs", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
  ],
  [
    `powershell -NoProfile -Command "kill openclaw"`,
    ["powershell", "-NoProfile", "-Command", "kill openclaw"],
  ],
  ["Get-Process OpenClaw | Stop-Process", ["Get-Process", "OpenClaw", "|", "Stop-Process"]],
  ["Get-Process | Stop-Process", ["Get-Process", "|", "Stop-Process"]],
  ["Get-Service | Stop-Service", ["Get-Service", "|", "Stop-Service"]],
  ["(Get-Process OpenClaw) | Stop-Process", ["(Get-Process", "OpenClaw)", "|", "Stop-Process"]],
  ["Get-Service OpenClaw | Start-Service", ["Get-Service", "OpenClaw", "|", "Start-Service"]],
  ["Suspend-Service OpenClaw", ["Suspend-Service", "OpenClaw"]],
  ["Resume-Service OpenClaw", ["Resume-Service", "OpenClaw"]],
  ["Get-Service OpenClaw | Suspend-Service", ["Get-Service", "OpenClaw", "|", "Suspend-Service"]],
  ["Get-Service OpenClaw | Resume-Service", ["Get-Service", "OpenClaw", "|", "Resume-Service"]],
  ["Get-Service OpenClaw | Remove-Service", ["Get-Service", "OpenClaw", "|", "Remove-Service"]],
  [
    "Get-Service OpenClaw | Set-Service -StartupType Disabled",
    ["Get-Service", "OpenClaw", "|", "Set-Service", "-StartupType", "Disabled"],
  ],
  ["Get-Process OpenClaw | kill", ["Get-Process", "OpenClaw", "|", "kill"]],
  ["ps OpenClaw | kill", ["ps", "OpenClaw", "|", "kill"]],
  ["Stop-Process -Name Open*Claw", ["Stop-Process", "-Name", "Open*Claw"]],
  [
    "env env env env env env env env openclaw gateway restart",
    ["env", "env", "env", "env", "env", "env", "env", "env", "openclaw", "gateway", "restart"],
  ],
  ["xargs openclaw gateway", ["xargs", "openclaw", "gateway"]],
  ["xargs -d, openclaw", ["xargs", "-d,", "openclaw"]],
  ["printf 'gateway restart' | xargs openclaw", ["xargs", "openclaw"]],
  ["printf 'gateway' | xargs -I{} openclaw {}", ["xargs", "-I{}", "openclaw", "{}"]],
  ["pgrep openclaw | xargs kill", ["xargs", "kill"]],
  ["pgrep openclaw | xargs --no-run-if-empty kill", ["xargs", "--no-run-if-empty", "kill"]],
  ["xargs -I{} {} gateway restart", ["xargs", "-I{}", "{}", "gateway", "restart"]],
  ["xargs -0I{} {} gateway restart", ["xargs", "-0I{}", "{}", "gateway", "restart"]],
  ["xargs -i{} {} gateway restart", ["xargs", "-i{}", "{}", "gateway", "restart"]],
  ["xargs -J{} {} gateway restart", ["xargs", "-J{}", "{}", "gateway", "restart"]],
  ["xargs -I{} dash -c {}", ["xargs", "-I{}", "dash", "-c", "{}"]],
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

const OUT_OF_SCOPE_OPENCLAW_RE =
  /^openclaw (?:(?:gateway call (?:config\.|exec\.approval))|approvals|config|configure|doctor|exec-policy|onboard|reset|setup|update)\b/u;

function isNarrowLifecycleCommand(command: string): boolean {
  return (
    !OUT_OF_SCOPE_OPENCLAW_RE.test(command) && !command.startsWith("npm exec -- openclaw config ")
  );
}

const nonMutationCases: Array<[string, string[]]> = [
  ["openclaw gateway status", ["openclaw", "gateway", "status"]],
  ["openclaw daemon logs", ["openclaw", "daemon", "logs"]],
  ["openclaw --help gateway restart", ["openclaw", "--help", "gateway", "restart"]],
  ["openclaw --version gateway restart", ["openclaw", "--version", "gateway", "restart"]],
  ["openclaw gateway --help", ["openclaw", "gateway", "--help"]],
  ["openclaw gateway call health", ["openclaw", "gateway", "call", "health"]],
  ["openclaw config get gateway.port", ["openclaw", "config", "get", "gateway.port"]],
  ["openclaw config file", ["openclaw", "config", "file"]],
  ["openclaw config schema", ["openclaw", "config", "schema"]],
  ["openclaw config validate", ["openclaw", "config", "validate"]],
  ["openclaw doctor --lint", ["openclaw", "doctor", "--lint"]],
  ["openclaw doctor --post-upgrade", ["openclaw", "doctor", "--post-upgrade"]],
  ["openclaw onboard --help", ["openclaw", "onboard", "--help"]],
  ["openclaw node status", ["openclaw", "node", "status"]],
  ["openclaw node identity", ["openclaw", "node", "identity"]],
  ["openclaw node install --help", ["openclaw", "node", "install", "--help"]],
  ["openclaw reset --dry-run", ["openclaw", "reset", "--dry-run"]],
  ["openclaw exec-policy show", ["openclaw", "exec-policy", "show"]],
  ["openclaw approvals pending", ["openclaw", "approvals", "pending"]],
  ["openclaw approvals get", ["openclaw", "approvals", "get"]],
  [
    "openclaw config set gateway.port 19001 --dry-run",
    ["openclaw", "config", "set", "gateway.port", "19001", "--dry-run"],
  ],
  [
    "openclaw config set gateway.port 19001 --dry-run=false --dry-run",
    ["openclaw", "config", "set", "gateway.port", "19001", "--dry-run=false", "--dry-run"],
  ],
  [
    "openclaw config get gateway.port -- --dry-run",
    ["openclaw", "config", "get", "gateway.port", "--", "--dry-run"],
  ],
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
  [
    "env env env env env env env env echo ok",
    ["env", "env", "env", "env", "env", "env", "env", "env", "echo", "ok"],
  ],
  ["npm install --prefix openclaw lodash", ["npm", "install", "--prefix", "openclaw", "lodash"]],
  ["npm install --dry-run openclaw", ["npm", "install", "--dry-run", "openclaw"]],
  [
    "npm install --dry-run=false --dry-run openclaw",
    ["npm", "install", "--dry-run=false", "--dry-run", "openclaw"],
  ],
  ["npm uninstall --dry-run openclaw", ["npm", "uninstall", "--dry-run", "openclaw"]],
  ["pnpm rebuild --dry-run openclaw", ["pnpm", "rebuild", "--dry-run", "openclaw"]],
  ["npm --help=true install openclaw", ["npm", "--help=true", "install", "openclaw"]],
  ["npm --version install openclaw", ["npm", "--version", "install", "openclaw"]],
  [
    `openclaw gateway status --token "$(cat token)"`,
    ["openclaw", "gateway", "status", "--token", "$(cat token)"],
  ],
  [
    `openclaw config get "$(printf gateway.port)"`,
    ["openclaw", "config", "get", "$(printf gateway.port)"],
  ],
];

describe("OpenClaw lifecycle exec approvals", () => {
  it.each(classifiedCases)("classifies the narrow lifecycle boundary for %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(isNarrowLifecycleCommand(command));
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

  it("resolves relative Node entry scripts against the command cwd", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "node dist/entry.js gateway restart",
        cwd: "/opt/openclaw",
        platform: "linux",
        segments: [
          {
            raw: "node dist/entry.js gateway restart",
            argv: ["node", "dist/entry.js", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("expands known references before scanning compound commands", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: 'echo "$($TOOL gateway restart)"',
        env: { TOOL: "openclaw" },
        platform: "linux",
        segments: [
          { raw: 'echo "$($TOOL gateway restart)"', argv: ["echo", "$($TOOL gateway restart)"] },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "Get-Process $env:NAME | Stop-Process",
        env: { NAME: "OpenClaw" },
        platform: "win32",
        segments: [
          {
            raw: "Get-Process $env:NAME | Stop-Process",
            argv: ["Get-Process", "$env:NAME", "|", "Stop-Process"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "echo '$TOOL gateway restart'",
        env: { TOOL: "openclaw" },
        platform: "linux",
        segments: [
          { raw: "echo '$TOOL gateway restart'", argv: ["echo", "$TOOL gateway restart"] },
        ],
      }),
    ).toBe(false);
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
        platform: "linux",
        segments: [
          {
            raw: "${TOOL:-openclaw} gateway restart",
            argv: ["${TOOL:-openclaw}", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed for unsupported parameter transformations", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "${TOOL,,} gateway restart",
        env: { TOOL: "OPENCLAW" },
        platform: "linux",
        segments: [
          {
            raw: "${TOOL,,} gateway restart",
            argv: ["${TOOL,,}", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      requiresApproval("sh -c '${1,,} gateway restart' sh OPENCLAW", [
        "sh",
        "-c",
        "${1,,} gateway restart",
        "sh",
        "OPENCLAW",
      ]),
    ).toBe(true);
  });

  it("uses PowerShell semantics for the Windows kill alias", () => {
    expect(requiresApproval("kill -Name OpenClaw", ["kill", "-Name", "OpenClaw"], "win32")).toBe(
      true,
    );
    expect(requiresApproval("kill -Name Open*Claw", ["kill", "-Name", "Open*Claw"], "win32")).toBe(
      true,
    );
    expect(requiresApproval("kill -Id 123", ["kill", "-Id", "123"], "win32")).toBe(false);
  });

  it("uses PowerShell Start-Process layouts on Windows", () => {
    expect(
      requiresApproval(
        "Start-Process -FilePath openclaw -ArgumentList 'gateway'",
        ["Start-Process", "-FilePath", "openclaw", "-ArgumentList", "gateway"],
        "win32",
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        "Start-Process openclaw 'gateway restart'",
        ["Start-Process", "openclaw", "gateway restart"],
        "win32",
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        "Start-Process -Arg 'gateway restart' -File openclaw",
        ["Start-Process", "-Arg", "gateway restart", "-File", "openclaw"],
        "win32",
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        "Start-Process notepad -ArgumentList 'openclaw gateway'",
        ["Start-Process", "notepad", "-ArgumentList", "openclaw gateway"],
        "win32",
      ),
    ).toBe(false);
    expect(
      requiresApproval(
        "Start-Process -FilePath:openclaw -ArgumentList:'gateway restart'",
        ["Start-Process", "-FilePath:openclaw", "-ArgumentList:gateway restart"],
        "win32",
      ),
    ).toBe(true);
  });

  it("does not mistake an OpenClaw profile value for a read-only command", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: 'openclaw --profile status "${COMMAND:-update}"',
        env: {},
        platform: "linux",
        segments: [
          {
            raw: 'openclaw --profile status "${COMMAND:-update}"',
            argv: ["openclaw", "--profile", "status", "${COMMAND:-update}"],
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

  it("keeps benign unresolved shell data non-blocking", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `sh -c 'echo "$UNSET"'`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `sh -c 'echo "$UNSET"'`,
            argv: ["sh", "-c", 'echo "$UNSET"'],
          },
        ],
      }),
    ).toBe(false);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `sh -c 'echo ok; $TOOL gateway restart'`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `sh -c 'echo ok; $TOOL gateway restart'`,
            argv: ["sh", "-c", "echo ok; $TOOL gateway restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed for unresolved lifecycle runner targets", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `node "$ENTRY" gateway restart`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `node "$ENTRY" gateway restart`,
            argv: ["node", "$ENTRY", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `npm install "$PACKAGE"`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `npm install "$PACKAGE"`,
            argv: ["npm", "install", "$PACKAGE"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed for CMD delayed-expansion lifecycle commands", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `cmd.exe /V:ON /C "set TOOL=openclaw && !TOOL! gateway restart"`,
        env: {},
        envComplete: false,
        platform: "win32",
        segments: [
          {
            raw: `cmd.exe /V:ON /C "set TOOL=openclaw && !TOOL! gateway restart"`,
            argv: ["cmd.exe", "/V:ON", "/C", "set TOOL=openclaw && !TOOL! gateway restart"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `cmd.exe /V:ON /C "echo !UNSET!"`,
        env: {},
        envComplete: false,
        platform: "win32",
        segments: [
          {
            raw: `cmd.exe /V:ON /C "echo !UNSET!"`,
            argv: ["cmd.exe", "/V:ON", "/C", "echo !UNSET!"],
          },
        ],
      }),
    ).toBe(false);
    expect(
      requiresApproval(
        `cmd.exe /C "echo ^& openclaw gateway restart"`,
        ["cmd.exe", "/C", "echo ^& openclaw gateway restart"],
        "win32",
      ),
    ).toBe(false);
  });

  it("keeps unresolved gateway option values non-blocking for status", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `openclaw gateway status --token "$TOKEN"`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `openclaw gateway status --token "$TOKEN"`,
            argv: ["openclaw", "gateway", "status", "--token", "$TOKEN"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("fails closed for unresolved gateway RPC methods", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "openclaw gateway call \"${METHOD:-update.run}\" --params '{}'",
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: "openclaw gateway call \"${METHOD:-update.run}\" --params '{}'",
            argv: ["openclaw", "gateway", "call", "${METHOD:-update.run}", "--params", "{}"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails closed for unresolved PowerShell lifecycle selectors", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: "Get-Process $env:NAME | Stop-Process",
        env: {},
        envComplete: false,
        platform: "win32",
        segments: [
          {
            raw: "Get-Process $env:NAME | Stop-Process",
            argv: ["Get-Process", "$env:NAME", "|", "Stop-Process"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps benign unresolved env payload data non-blocking", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `env echo "$UNSET"`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [{ raw: `env echo "$UNSET"`, argv: ["env", "echo", "$UNSET"] }],
      }),
    ).toBe(false);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `env "$TOOL" gateway restart`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          { raw: `env "$TOOL" gateway restart`, argv: ["env", "$TOOL", "gateway", "restart"] },
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
