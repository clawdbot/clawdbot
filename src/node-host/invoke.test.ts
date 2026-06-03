import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { SkillBinsProvider } from "./invoke-types.js";
import { handleInvoke } from "./invoke.js";

describe("node host invoke", () => {
  it.runIf(process.platform !== "win32")(
    "reports current allow-always coverage for prepared shell-wrapped system.run commands",
    async () => {
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const skillBins: SkillBinsProvider = { current: async () => [] };

      await handleInvoke(
        {
          id: "invoke-prepare",
          nodeId: "node-1",
          command: "system.run.prepare",
          paramsJSON: JSON.stringify({
            command: ["/bin/sh", "-lc", "/bin/echo ok"],
            rawCommand: "/bin/echo ok",
          }),
        },
        { request } as unknown as GatewayClient,
        skillBins,
      );

      const result = request.mock.calls[0]?.[1] as { payloadJSON?: string } | undefined;
      const payload = JSON.parse(result?.payloadJSON ?? "{}") as {
        allowAlwaysCoverage?: {
          complete?: boolean;
          patterns?: Array<{ pattern?: string }>;
        };
      };
      expect(payload.allowAlwaysCoverage?.complete).toBe(true);
      expect(payload.allowAlwaysCoverage?.patterns?.[0]?.pattern).toBe(
        fs.realpathSync("/bin/echo"),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects blocked forwarded env overrides in system.run.prepare",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prepare-env-"));
      const toolPath = path.join(tempDir, "tool");
      fs.writeFileSync(toolPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(toolPath, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;

      try {
        const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
        const skillBins: SkillBinsProvider = { current: async () => [] };

        await handleInvoke(
          {
            id: "invoke-prepare-env",
            nodeId: "node-1",
            command: "system.run.prepare",
            paramsJSON: JSON.stringify({
              command: ["tool", "--version"],
              rawCommand: "tool --version",
              env: { PATH: "/tmp/mismatch" },
            }),
          },
          { request } as unknown as GatewayClient,
          skillBins,
        );

        expect(request).toHaveBeenCalledWith(
          "node.invoke.result",
          expect.objectContaining({
            id: "invoke-prepare-env",
            nodeId: "node-1",
            ok: false,
            error: expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringContaining("blocked override keys: PATH"),
            }),
          }),
        );
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("wraps malformed paramsJSON for built-in commands", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: "{not json",
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "invoke-1",
        nodeId: "node-1",
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("paramsJSON malformed JSON"),
        }),
      }),
    );
  });

  it("includes effective exec policy in system.run.prepare responses", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run.prepare",
        paramsJSON: JSON.stringify({
          command: ["echo", "ok"],
          rawCommand: "echo ok",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.any(String),
      }),
    );
    const result = request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as {
      payloadJSON?: string;
    };
    const payload = JSON.parse(result.payloadJSON ?? "{}") as {
      execPolicy?: { security?: string; ask?: string };
    };
    expect(payload.execPolicy).toEqual({ security: "allowlist", ask: "on-miss" });
  });
});
