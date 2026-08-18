import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  createChildEnv,
  parseNodeMcpTextRecord,
  processIsAlive,
  startHttpFixture,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("gateway node MCP fixture ownership", () => {
  it.each([
    ["direct", (payload: object) => payload],
    ["node.invoke", (payload: object) => ({ ok: true, payload })],
  ])("parses %s MCP text records", (_label, wrap) => {
    const fact = { label: "node-stdio", marker: "ready", pid: 42 };
    expect(
      parseNodeMcpTextRecord(wrap({ content: [{ type: "text", text: JSON.stringify(fact) }] })),
    ).toEqual(fact);
  });

  it("kills a spawned fixture when readiness validation fails", async () => {
    const root = tempDirs.make("mcp-fixture-startup-failure-");
    const fixturePath = path.join(root, "invalid-fixture.mjs");
    const pidPath = path.join(root, "fixture.pid");
    await fs.writeFile(
      fixturePath,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); console.log(JSON.stringify({type:"wrong"})); setInterval(() => {}, 1000);`,
      "utf8",
    );

    await expect(
      startHttpFixture({
        fixturePath,
        labelPrefix: "node",
        env: createChildEnv({ home: root, tempDir: os.tmpdir() }),
      }),
    ).rejects.toThrow("invalid readiness");
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    try {
      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 1_000 });
    } finally {
      if (processIsAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    expect(processIsAlive(pid)).toBe(false);
  });
});
