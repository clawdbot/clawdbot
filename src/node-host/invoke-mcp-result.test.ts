import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("boundMcpToolResultPayload", () => {
  it("bounds a resident 64 MiB audio result under a constrained process heap", async () => {
    const source = String.raw`
      import { boundMcpToolResultPayload } from ${JSON.stringify(new URL("./invoke-mcp-result.ts", import.meta.url).href)};
      const payload = boundMcpToolResultPayload({
        content: [{ type: "audio", data: "A".repeat(64 * 1024 * 1024), mimeType: "audio/wav" }],
      });
      process.stdout.write(JSON.stringify({ payload, rss: process.memoryUsage().rss }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=128", "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1024 * 1024 },
    );

    const result = JSON.parse(stdout) as {
      payload: { content: Array<{ type: string; text?: string }> };
      rss: number;
    };
    expect(result.payload.content).toEqual([
      { type: "text", text: "[truncated: MCP result exceeded 20 MB]" },
    ]);
    expect(result.rss).toBeLessThan(300 * 1024 * 1024);
  });
});
