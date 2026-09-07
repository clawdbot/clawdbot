import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveStdioMcpServerLaunchConfig } from "./mcp-stdio.js";

describe.runIf(process.platform === "win32")("OpenClawStdioClientTransport on Windows", () => {
  it("applies configured environment overrides regardless of key case", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-env-case-"));
    const inheritedTemp = path.join(root, "inherited");
    const configuredTemp = path.join(root, "configured");
    const capturePath = path.join(root, "captured.txt");
    await fs.mkdir(inheritedTemp);
    await fs.mkdir(configuredTemp);
    const previousTemp = process.env.TEMP;
    process.env.TEMP = inheritedTemp;
    let transport: OpenClawStdioClientTransport | undefined;

    try {
      const resolved = resolveStdioMcpServerLaunchConfig({
        command: process.execPath,
        args: [
          "-e",
          'require("node:fs").writeFileSync(process.env.OPENCLAW_MCP_ENV_CAPTURE, process.env.TEMP)',
        ],
        env: {
          temp: configuredTemp,
          OPENCLAW_MCP_ENV_CAPTURE: capturePath,
        },
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        return;
      }

      transport = new OpenClawStdioClientTransport(resolved.config);
      const closed = new Promise<void>((resolve, reject) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
        transport!.onclose = resolve;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses callback properties, not EventTarget.
        transport!.onerror = reject;
      });
      await transport.start();
      await closed;

      await expect(fs.readFile(capturePath, "utf8")).resolves.toBe(configuredTemp);
    } finally {
      await transport?.forceClose();
      if (previousTemp === undefined) {
        delete process.env.TEMP;
      } else {
        process.env.TEMP = previousTemp;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
