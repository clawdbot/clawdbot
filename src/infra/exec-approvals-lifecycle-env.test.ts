import { describe, expect, it } from "vitest";
import { commandRequiresOpenClawLifecycleApproval } from "./exec-approvals.js";

describe("OpenClaw lifecycle environment data positions", () => {
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
