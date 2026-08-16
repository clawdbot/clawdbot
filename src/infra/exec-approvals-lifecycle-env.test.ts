import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

describe("OpenClaw lifecycle environment data positions", () => {
  it.each([
    [`echo "$TEXT"`, ["echo", "$TEXT"], "$(openclaw gateway restart)"],
    [`echo "$TEXT"`, ["echo", "$TEXT"], "safe; openclaw gateway restart"],
    [`openclaw "$ACTION"`, ["openclaw", "$ACTION"], "$(printf restart)"],
  ] as Array<[string, string[], string]>)(
    "does not reparse expanded environment data: %s",
    (command, argv, value) => {
      const key = command.includes("$ACTION") ? "ACTION" : "TEXT";
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          env: { [key]: value },
          envComplete: true,
          platform: "linux",
          segments: [{ raw: command, argv }],
        }),
      ).toBe(false);
    },
  );

  it("preserves POSIX field-splitting uncertainty for unquoted executable references", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `$TOOL restart`,
        env: { TOOL: "openclaw gateway" },
        envComplete: true,
        platform: "linux",
        segments: [{ raw: `$TOOL restart`, argv: ["$TOOL", "restart"] }],
      }),
    ).toBe(true);
  });

  it("preserves POSIX field-removal uncertainty for known empty references", () => {
    const command = `$EMPTY openclaw gateway restart`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { EMPTY: "" },
        envComplete: true,
        platform: "linux",
        segments: [{ raw: command, argv: ["$EMPTY", "openclaw", "gateway", "restart"] }],
      }),
    ).toBe(true);
  });

  it("uses target-platform environment name semantics", () => {
    const command = `$tool gateway restart`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { TOOL: "echo" },
        envComplete: false,
        platform: "linux",
        segments: [{ raw: command, argv: ["$tool", "gateway", "restart"] }],
      }),
    ).toBe(true);
  });

  it("keeps unresolved variables in non-lifecycle data positions non-blocking", () => {
    const cases: Array<{ command: string; argv: string[]; platform?: NodeJS.Platform }> = [
      {
        command: `npm install lodash --registry "$REGISTRY"`,
        argv: ["npm", "install", "lodash", "--registry", "$REGISTRY"],
      },
      {
        command: `powershell -Command "Write-Output $env:NAME"`,
        argv: ["powershell", "-Command", "Write-Output $env:NAME"],
        platform: "win32",
      },
      {
        command: `openclaw config get "$KEY"`,
        argv: ["openclaw", "config", "get", "$KEY"],
      },
      {
        command: `openclaw approvals get "$ID"`,
        argv: ["openclaw", "approvals", "get", "$ID"],
      },
      {
        command: `node --loader "$LOADER" app.mjs gateway restart`,
        argv: ["node", "--loader", "$LOADER", "app.mjs", "gateway", "restart"],
      },
      {
        command: `Start-Process notepad -ArgumentList "gateway restart" -WorkingDirectory "$DIR"`,
        argv: [
          "Start-Process",
          "notepad",
          "-ArgumentList",
          "gateway restart",
          "-WorkingDirectory",
          "$DIR",
        ],
        platform: "win32",
      },
    ];
    for (const testCase of cases) {
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command: testCase.command,
          env: {},
          envComplete: false,
          platform: testCase.platform ?? "linux",
          segments: [{ raw: testCase.command, argv: testCase.argv }],
        }),
      ).toBe(false);
    }
  });

  it("does not trust initial environment values shadowed by shell assignments", () => {
    const cases: Array<{ command: string; argv: string[] }> = [
      {
        command: `ACTION=restart; openclaw gateway "$ACTION"`,
        argv: ["openclaw", "gateway", "$ACTION"],
      },
      {
        command: `sh -c 'ACTION=restart; openclaw gateway "$ACTION"'`,
        argv: ["sh", "-c", `ACTION=restart; openclaw gateway "$ACTION"`],
      },
    ];
    for (const testCase of cases) {
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command: testCase.command,
          env: { ACTION: "status" },
          platform: "linux",
          segments: [{ raw: testCase.command, argv: testCase.argv }],
        }),
        testCase.command,
      ).toBe(true);
    }
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `VALUE=hello; echo "$VALUE"`,
        env: { VALUE: "status" },
        segments: [{ raw: `echo "$VALUE"`, argv: ["echo", "$VALUE"] }],
      }),
    ).toBe(false);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `ACTION=restart openclaw gateway "$ACTION"`,
        env: { ACTION: "status" },
        platform: "linux",
        segments: [
          {
            raw: `ACTION=restart openclaw gateway "$ACTION"`,
            argv: ["ACTION=restart", "openclaw", "gateway", "$ACTION"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("uses PowerShell scope instead of process environment for local variables", () => {
    const localInvocation = `$TOOL = 'openclaw'; & $TOOL gateway restart`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: localInvocation,
        env: { TOOL: "echo" },
        envComplete: true,
        platform: "win32",
        segments: [
          {
            raw: `& $TOOL gateway restart`,
            argv: ["&", "$TOOL", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `Write-Output $TOOL`,
        env: { TOOL: "openclaw" },
        envComplete: true,
        platform: "win32",
        segments: [{ raw: `Write-Output $TOOL`, argv: ["Write-Output", "$TOOL"] }],
      }),
    ).toBe(false);
  });

  it("expands explicit PowerShell environment references in invocations", () => {
    const command = `& $env:TOOL gateway restart`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { TOOL: "openclaw" },
        envComplete: true,
        platform: "win32",
        segments: [{ raw: command, argv: ["&", "$env:TOOL", "gateway", "restart"] }],
      }),
    ).toBe(true);
  });

  it("keeps unresolved plugin and hook actions outside the lifecycle boundary", () => {
    for (const family of ["plugins", "hooks"]) {
      const command = `ACTION=install; openclaw ${family} "$ACTION" memory`;
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          env: { ACTION: "list" },
          platform: "linux",
          segments: [
            {
              raw: `openclaw ${family} "$ACTION" memory`,
              argv: ["openclaw", family, "$ACTION", "memory"],
            },
          ],
        }),
        family,
      ).toBe(false);
    }
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `FLAG=--refresh; openclaw plugins registry "$FLAG"`,
        env: { FLAG: "--json" },
        platform: "linux",
        segments: [
          {
            raw: `openclaw plugins registry "$FLAG"`,
            argv: ["openclaw", "plugins", "registry", "$FLAG"],
          },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    [`openclaw update --dry-run="$DRY"`, ["openclaw", "update", "--dry-run=$DRY"], false],
    [
      `openclaw config set gateway.port 19001 --dry-run="$DRY"`,
      ["openclaw", "config", "set", "gateway.port", "19001", "--dry-run=$DRY"],
      false,
    ],
    [`openclaw reset --dry-run="$DRY"`, ["openclaw", "reset", "--dry-run=$DRY"], false],
    [
      `openclaw plugins update memory --dry-run="$DRY"`,
      ["openclaw", "plugins", "update", "memory", "--dry-run=$DRY"],
      false,
    ],
    [
      `openclaw hooks update audit --dry-run="$DRY"`,
      ["openclaw", "hooks", "update", "audit", "--dry-run=$DRY"],
      false,
    ],
    [`openclaw uninstall --dry-run="$DRY"`, ["openclaw", "uninstall", "--dry-run=$DRY"], true],
    [
      `npm install openclaw --dry-run="$DRY"`,
      ["npm", "install", "openclaw", "--dry-run=$DRY"],
      true,
    ],
  ] as Array<[string, string[], boolean]>)(
    "classifies dynamic preview flags within the lifecycle boundary: %s",
    (payload, argv, expected) => {
      const command = `DRY=false; export DRY; ${payload}`;
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          env: { DRY: "true" },
          platform: "linux",
          segments: [{ raw: payload, argv }],
        }),
      ).toBe(expected);
    },
  );

  it("keeps unresolved xargs data operands non-blocking", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `xargs echo "$PREFIX"`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [{ raw: `xargs echo "$PREFIX"`, argv: ["xargs", "echo", "$PREFIX"] }],
      }),
    ).toBe(false);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `xargs "$TOOL" gateway restart`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `xargs "$TOOL" gateway restart`,
            argv: ["xargs", "$TOOL", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "POSIX positional parameters",
      command: `set -- update; openclaw "$1"`,
      env: {},
      platform: "linux" as const,
      raw: `openclaw "$1"`,
      argv: ["openclaw", "$1"],
    },
    {
      name: "CMD variable modifiers",
      command: `cmd /c "openclaw %ACTION:status=update%"`,
      env: { ACTION: "status" },
      platform: "win32" as const,
      raw: `cmd /c "openclaw %ACTION:status=update%"`,
      argv: ["cmd", "/c", "openclaw %ACTION:status=update%"],
    },
    {
      name: "PowerShell argument splats",
      command: `$verbs = @('update'); & openclaw @verbs`,
      env: {},
      platform: "win32" as const,
      raw: `& openclaw @verbs`,
      argv: ["&", "openclaw", "@verbs"],
    },
    {
      name: "PowerShell Start-Process splats",
      command: `$params = @{FilePath='openclaw';ArgumentList='update'}; Start-Process @params`,
      env: {},
      platform: "win32" as const,
      raw: `Start-Process @params`,
      argv: ["Start-Process", "@params"],
    },
    {
      name: "opaque process-environment writes",
      command: `[Environment]::SetEnvironmentVariable('ACTION','update'); & openclaw $env:ACTION`,
      env: { ACTION: "--help" },
      platform: "win32" as const,
      raw: `& openclaw $env:ACTION`,
      argv: ["&", "openclaw", "$env:ACTION"],
    },
  ])("fails closed for $name", ({ argv, command, env, platform, raw }) => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env,
        envComplete: true,
        platform,
        segments: [{ raw, argv }],
      }),
    ).toBe(true);
  });

  it("classifies process selectors after known environment expansion", () => {
    const command = `kill -TERM "$(pidof "$PROC")"`;
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command,
        env: { PROC: "openclaw" },
        envComplete: true,
        platform: "linux",
        segments: [{ raw: command, argv: ["kill", "-TERM", `$(pidof "$PROC")`] }],
      }),
    ).toBe(true);
  });
});

describe("OpenClaw lifecycle dynamic carrier edges", () => {
  const requiresApproval = (command: string, argv: string[]): boolean =>
    commandRequiresOpenClawLifecycleApproval({
      command,
      platform: "linux",
      segments: [{ raw: command, argv }],
    });

  it.each([
    [
      `cmd /c "for %X in (openclaw) do %X gateway restart"`,
      ["cmd", "/c", "for %X in (openclaw) do %X gateway restart"],
    ],
    [
      `cmd /c "for %X in (openclaw) do call %X gateway restart"`,
      ["cmd", "/c", "for %X in (openclaw) do call %X gateway restart"],
    ],
    [
      `powershell -Command '& ("open" + "claw") gateway restart'`,
      ["powershell", "-Command", `& ("open" + "claw") gateway restart`],
    ],
  ] as Array<[string, string[]]>)(
    "fails closed for calculated shell target: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    [
      "npx tsx /opt/openclaw/dist/entry.js gateway restart",
      ["npx", "tsx", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
    ],
    [
      "pnpm dlx tsx /opt/openclaw/dist/entry.js gateway restart",
      ["pnpm", "dlx", "tsx", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
    ],
  ] as Array<[string, string[]]>)(
    "recognizes OpenClaw entry scripts behind JS runner: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it("keeps read-only OpenClaw entry-script runners non-blocking", () => {
    const command = "npx tsx /opt/openclaw/dist/entry.js status";
    expect(requiresApproval(command, ["npx", "tsx", "/opt/openclaw/dist/entry.js", "status"])).toBe(
      false,
    );
  });

  it.each([
    [
      "npx --dry-run openclaw gateway restart",
      ["npx", "--dry-run", "openclaw", "gateway", "restart"],
    ],
    [
      "npm --dry-run exec -- openclaw gateway restart",
      ["npm", "--dry-run", "exec", "--", "openclaw", "gateway", "restart"],
    ],
  ] as Array<[string, string[]]>)(
    "does not suppress package execution targets with dry-run: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it("still treats package mutation dry-runs as non-mutating", () => {
    const command = "npm --dry-run install openclaw";
    expect(requiresApproval(command, ["npm", "--dry-run", "install", "openclaw"])).toBe(false);
  });

  it("forwards info-shaped arguments that follow a package execution target", () => {
    const command = "npx openclaw gateway --token --help";
    expect(requiresApproval(command, ["npx", "openclaw", "gateway", "--token", "--help"])).toBe(
      true,
    );
    expect(
      requiresApproval("npx --help openclaw gateway", ["npx", "--help", "openclaw", "gateway"]),
    ).toBe(false);
  });

  it.each([
    ["yarn workspace app add openclaw", ["yarn", "workspace", "app", "add", "openclaw"]],
    [
      "yarn workspace app run openclaw -- gateway restart",
      ["yarn", "workspace", "app", "run", "openclaw", "--", "gateway", "restart"],
    ],
    [
      "yarn workspaces foreach -A add openclaw",
      ["yarn", "workspaces", "foreach", "-A", "add", "openclaw"],
    ],
  ] as Array<[string, string[]]>)("unwraps Yarn workspace dispatch: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it("keeps read-only Yarn workspace dispatch non-blocking", () => {
    const command = "yarn workspace app run openclaw -- status";
    expect(
      requiresApproval(command, ["yarn", "workspace", "app", "run", "openclaw", "--", "status"]),
    ).toBe(false);
  });

  it.each([
    [
      "/usr/bin/syste?ctl restart openclaw-gateway.service",
      ["/usr/bin/syste?ctl", "restart", "openclaw-gateway.service"],
    ],
    ["/usr/bin/pk?ll -TERM openclaw", ["/usr/bin/pk?ll", "-TERM", "openclaw"]],
    [
      "{{openclaw,--dev},--no-color} gateway restart",
      ["{{openclaw,--dev},--no-color}", "gateway", "restart"],
    ],
    [
      "npm exec -- oc@npm:openclaw@latest gateway restart",
      ["npm", "exec", "--", "oc@npm:openclaw@latest", "gateway", "restart"],
    ],
    [
      "pnpm dlx oc@npm:openclaw@latest gateway restart",
      ["pnpm", "dlx", "oc@npm:openclaw@latest", "gateway", "restart"],
    ],
  ] as Array<[string, string[]]>)(
    "classifies executable expansion carriers: %s",
    (command, argv) => {
      expect(requiresApproval(command, argv)).toBe(true);
    },
  );

  it.each([
    [
      "tsx /opt/openclaw/dist/entry.js gateway restart",
      ["tsx", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
    ],
    [
      "nodejs /opt/openclaw/dist/entry.js gateway restart",
      ["nodejs", "/opt/openclaw/dist/entry.js", "gateway", "restart"],
    ],
    ["service openclaw-gateway --full-restart", ["service", "openclaw-gateway", "--full-restart"]],
  ] as Array<[string, string[]]>)("classifies direct lifecycle runner: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it("keeps a read-only direct JavaScript runner non-blocking", () => {
    const command = "tsx /opt/openclaw/dist/entry.js status";
    expect(requiresApproval(command, ["tsx", "/opt/openclaw/dist/entry.js", "status"])).toBe(false);
  });

  it.each([
    [
      "printf gateway | xargs -I{} /opt/openclaw/dist/entry.js {} restart",
      ["xargs", "-I{}", "/opt/openclaw/dist/entry.js", "{}", "restart"],
    ],
    [
      "printf 'gateway restart' | xargs /opt/openclaw/dist/entry.js",
      ["xargs", "/opt/openclaw/dist/entry.js"],
    ],
    [
      "printf gateway | xargs -I{} tsx /opt/openclaw/dist/entry.js {} restart",
      ["xargs", "-I{}", "tsx", "/opt/openclaw/dist/entry.js", "{}", "restart"],
    ],
  ] as Array<[string, string[]]>)("classifies xargs entry runners: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it.each([
    ["nodejs", ["gateway", "restart"], true],
    ["tsx", ["gateway", "restart"], true],
    ["bun", ["gateway", "restart"], true],
    ["node", ["exec-policy", "preset", "yolo"], false],
    ["nodejs", ["config", "set", "gateway.port", "19001"], false],
  ] as Array<[string, string[], boolean]>)(
    "classifies an unresolved %s entry script by its lifecycle argv",
    (runner, args, expected) => {
      const command = `${runner} "$ENTRY" ${args.join(" ")}`;
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          env: {},
          envComplete: false,
          platform: "linux",
          segments: [{ raw: command, argv: [runner, "$ENTRY", ...args] }],
        }),
      ).toBe(expected);
    },
  );

  it.each([
    [
      "hash -p /usr/local/bin/openclaw oc; oc gateway restart",
      ["hash", "-p", "/usr/local/bin/openclaw", "oc", ";", "oc", "gateway", "restart"],
    ],
    [
      "hash -p /usr/bin/systemctl ctl; ctl restart openclaw-gateway.service",
      [
        "hash",
        "-p",
        "/usr/bin/systemctl",
        "ctl",
        ";",
        "ctl",
        "restart",
        "openclaw-gateway.service",
      ],
    ],
    [
      "alias oc='openclaw'; oc gateway restart",
      ["alias", "oc=openclaw", ";", "oc", "gateway", "restart"],
    ],
    [
      "if hash -p /usr/local/bin/openclaw oc; then :; fi; oc gateway restart",
      [
        "if",
        "hash",
        "-p",
        "/usr/local/bin/openclaw",
        "oc",
        ";",
        "then",
        ":",
        ";",
        "fi",
        ";",
        "oc",
        "gateway",
        "restart",
      ],
    ],
    [
      "if builtin hash -p /usr/local/bin/openclaw oc; then :; fi; oc gateway restart",
      [
        "if",
        "builtin",
        "hash",
        "-p",
        "/usr/local/bin/openclaw",
        "oc",
        ";",
        "then",
        ":",
        ";",
        "fi",
        ";",
        "oc",
        "gateway",
        "restart",
      ],
    ],
  ] as Array<[string, string[]]>)("tracks POSIX command bindings: %s", (command, argv) => {
    expect(requiresApproval(command, argv)).toBe(true);
  });

  it("keeps signal-zero probes non-mutating unless a later signal overrides them", () => {
    expect(requiresApproval("pkill -0 -x openclaw", ["pkill", "-0", "-x", "openclaw"])).toBe(false);
    expect(
      requiresApproval("pkill --signal 0 -f openclaw", [
        "pkill",
        "--signal",
        "0",
        "-f",
        "openclaw",
      ]),
    ).toBe(false);
    expect(requiresApproval("pkill -s 0 -f openclaw", ["pkill", "-s", "0", "-f", "openclaw"])).toBe(
      true,
    );
    expect(requiresApproval("pkill -0 -TERM openclaw", ["pkill", "-0", "-TERM", "openclaw"])).toBe(
      true,
    );
  });

  it("fails closed when an unknown package option can consume a no-execute flag", () => {
    expect(
      requiresApproval("npm install --user-agent --dry-run openclaw", [
        "npm",
        "install",
        "--user-agent",
        "--dry-run",
        "openclaw",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("npm install --user-agent=agent --dry-run openclaw", [
        "npm",
        "install",
        "--user-agent=agent",
        "--dry-run",
        "openclaw",
      ]),
    ).toBe(false);
  });

  it("does not trust package-runner info flags after ambiguous options", () => {
    expect(
      requiresApproval("npx --user-agent --help openclaw gateway restart", [
        "npx",
        "--user-agent",
        "--help",
        "openclaw",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("npm exec --user-agent --help -- openclaw gateway restart", [
        "npm",
        "exec",
        "--user-agent",
        "--help",
        "--",
        "openclaw",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval("npx --user-agent=agent --help openclaw gateway restart", [
        "npx",
        "--user-agent=agent",
        "--help",
        "openclaw",
        "gateway",
        "restart",
      ]),
    ).toBe(false);
  });

  it("does not inspect an uninvoked shell function body", () => {
    const command = "sh -c 'f(){ openclaw gateway restart; }'";
    expect(requiresApproval(command, ["sh", "-c", "f(){ openclaw gateway restart; }"])).toBe(false);
    const substitution = `sh -c 'f(){ echo "$(openclaw gateway restart)"; }'`;
    expect(
      requiresApproval(substitution, ["sh", "-c", `f(){ echo "$(openclaw gateway restart)"; }`]),
    ).toBe(false);
    const dormantBinding = "sh -c 'f(){ hash -p /usr/local/bin/openclaw oc; }; oc gateway restart'";
    expect(
      requiresApproval(dormantBinding, [
        "sh",
        "-c",
        "f(){ hash -p /usr/local/bin/openclaw oc; }; oc gateway restart",
      ]),
    ).toBe(false);
  });

  it("does not honor killall help operands after the option terminator", () => {
    expect(
      requiresApproval("killall -- openclaw --help", ["killall", "--", "openclaw", "--help"]),
    ).toBe(true);
    expect(requiresApproval("killall --help openclaw", ["killall", "--help", "openclaw"])).toBe(
      false,
    );
  });

  it("fails closed for function-local argv and dynamic Corepack managers", () => {
    expect(
      requiresApproval(`sh -c 'f(){ "$@"; }; f openclaw gateway restart' sh`, [
        "sh",
        "-c",
        `f(){ "$@"; }; f openclaw gateway restart`,
        "sh",
      ]),
    ).toBe(true);
    expect(
      requiresApproval(`corepack "$(printf pnpm)" dlx openclaw gateway restart`, [
        "corepack",
        "$(printf pnpm)",
        "dlx",
        "openclaw",
        "gateway",
        "restart",
      ]),
    ).toBe(true);
    expect(
      requiresApproval(`corepack "$MANAGER" dlx openclaw exec-policy preset yolo`, [
        "corepack",
        "$MANAGER",
        "dlx",
        "openclaw",
        "exec-policy",
        "preset",
        "yolo",
      ]),
    ).toBe(false);
    expect(
      requiresApproval(`sh -c 'f(){ echo "$@"; }; f openclaw gateway restart' sh`, [
        "sh",
        "-c",
        `f(){ echo "$@"; }; f openclaw gateway restart`,
        "sh",
      ]),
    ).toBe(false);
    expect(
      requiresApproval(`sh -c 'f(){ openclaw "$@"; }; f gateway restart' sh`, [
        "sh",
        "-c",
        `f(){ openclaw "$@"; }; f gateway restart`,
        "sh",
      ]),
    ).toBe(true);
    expect(
      requiresApproval(`sh -c 'f(){ openclaw "$1"; }; f gateway' sh`, [
        "sh",
        "-c",
        `f(){ openclaw "$1"; }; f gateway`,
        "sh",
      ]),
    ).toBe(true);
    expect(
      requiresApproval(`sh -c 'f(){ openclaw "\${1:-status}"; }; if f gateway; then :; fi' sh`, [
        "sh",
        "-c",
        `f(){ openclaw "\${1:-status}"; }; if f gateway; then :; fi`,
        "sh",
      ]),
    ).toBe(true);
    expect(
      requiresApproval(`sh -c 'f(){ exec "$@"; }; f openclaw gateway restart' sh`, [
        "sh",
        "-c",
        `f(){ exec "$@"; }; f openclaw gateway restart`,
        "sh",
      ]),
    ).toBe(true);
  });

  it("recomputes environment syntax across mixed shell wrappers", () => {
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `echo ok; cmd /c "%TOOL% gateway restart"`,
        env: { TOOL: "openclaw" },
        platform: "win32",
        segments: [
          { raw: "echo ok", argv: ["echo", "ok"] },
          {
            raw: `cmd /c "%TOOL% gateway restart"`,
            argv: ["cmd", "/c", "%TOOL% gateway restart"],
          },
        ],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `cmd /c "powershell -Command '$env:TOOL gateway restart'"`,
        env: { TOOL: "openclaw" },
        platform: "win32",
        segments: [
          {
            raw: `cmd /c "powershell -Command '$env:TOOL gateway restart'"`,
            argv: ["cmd", "/c", `powershell -Command '$env:TOOL gateway restart'`],
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not trust inherited values shadowed by shell binders", () => {
    for (const inline of [
      `for TOOL in openclaw; do "$TOOL" gateway restart; done`,
      `read TOOL; "$TOOL" gateway restart`,
    ]) {
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command: `sh -c '${inline}'`,
          env: { TOOL: "echo" },
          envComplete: true,
          platform: "linux",
          segments: [{ raw: `sh -c '${inline}'`, argv: ["sh", "-c", inline] }],
        }),
      ).toBe(true);
    }
  });

  it("fails closed for dynamic direct node-service actions", () => {
    expect(
      requiresApproval(`openclaw node "$(printf restart)"`, [
        "openclaw",
        "node",
        "$(printf restart)",
      ]),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `openclaw node "$ACTION"`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [{ raw: `openclaw node "$ACTION"`, argv: ["openclaw", "node", "$ACTION"] }],
      }),
    ).toBe(true);
    expect(
      commandRequiresOpenClawLifecycleApproval({
        command: `node --run "$SCRIPT" -- gateway restart`,
        env: {},
        envComplete: false,
        platform: "linux",
        segments: [
          {
            raw: `node --run "$SCRIPT" -- gateway restart`,
            argv: ["node", "--run", "$SCRIPT", "--", "gateway", "restart"],
          },
        ],
      }),
    ).toBe(true);
  });
});
