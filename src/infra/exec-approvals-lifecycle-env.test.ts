import { describe, expect, it } from "vitest";
import { expandKnownLifecycleEnvironmentCommand } from "./exec-approvals-lifecycle-env.js";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

describe("OpenClaw lifecycle environment data positions", () => {
  it("uses shell-specific single-quote expansion semantics", () => {
    const command = `echo '%TOOL%'`;
    expect(
      expandKnownLifecycleEnvironmentCommand(command, { TOOL: "openclaw" }, new Set(), "cmd"),
    ).toBe(`echo 'openclaw'`);
    expect(
      expandKnownLifecycleEnvironmentCommand(
        command,
        { TOOL: "openclaw" },
        new Set(),
        "powershell",
      ),
    ).toBe(command);
    expect(
      expandKnownLifecycleEnvironmentCommand(command, { TOOL: "openclaw" }, new Set(), "posix"),
    ).toBe(command);
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

  it("fails closed for unresolved plugin and hook actions", () => {
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
      ).toBe(true);
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
    ).toBe(true);
  });

  it.each([
    [`openclaw update --dry-run="$DRY"`, ["openclaw", "update", "--dry-run=$DRY"]],
    [
      `openclaw config set gateway.port 19001 --dry-run="$DRY"`,
      ["openclaw", "config", "set", "gateway.port", "19001", "--dry-run=$DRY"],
    ],
    [`openclaw reset --dry-run="$DRY"`, ["openclaw", "reset", "--dry-run=$DRY"]],
    [
      `openclaw plugins update memory --dry-run="$DRY"`,
      ["openclaw", "plugins", "update", "memory", "--dry-run=$DRY"],
    ],
    [
      `openclaw hooks update audit --dry-run="$DRY"`,
      ["openclaw", "hooks", "update", "audit", "--dry-run=$DRY"],
    ],
    [`openclaw uninstall --dry-run="$DRY"`, ["openclaw", "uninstall", "--dry-run=$DRY"]],
    [`npm install openclaw --dry-run="$DRY"`, ["npm", "install", "openclaw", "--dry-run=$DRY"]],
  ] as Array<[string, string[]]>)(
    "fails closed when runtime expansion can disable preview mode: %s",
    (payload, argv) => {
      const command = `DRY=false; export DRY; ${payload}`;
      expect(
        commandRequiresOpenClawLifecycleApproval({
          command,
          env: { DRY: "true" },
          platform: "linux",
          segments: [{ raw: payload, argv }],
        }),
      ).toBe(true);
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
});

describe("OpenClaw lifecycle dynamic carrier edges", () => {
  const requiresApproval = (command: string, argv: string[]): boolean =>
    commandRequiresOpenClawLifecycleApproval({
      command,
      platform: "linux",
      segments: [{ raw: command, argv }],
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
      requiresApproval(`sh -c 'f(){ echo "$@"; }; f openclaw gateway restart' sh`, [
        "sh",
        "-c",
        `f(){ echo "$@"; }; f openclaw gateway restart`,
        "sh",
      ]),
    ).toBe(false);
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
  });
});
