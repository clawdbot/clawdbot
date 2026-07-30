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
});
