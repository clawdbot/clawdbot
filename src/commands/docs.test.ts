import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const runCommandWithTimeout = vi.fn();
const hasBinary = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout,
}));

vi.mock("../agents/skills.js", () => ({
  hasBinary,
}));

vi.mock("../terminal/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    command: (s: string) => s,
  },
}));

vi.mock("../terminal/links.js", () => ({
  formatDocsLink: (path: string, label: string) => `${label}${path}`,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (s: string) => s,
}));

const { docsSearchCommand } = await import("./docs.js");

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv & {
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
  };
}

describe("docsSearchCommand", () => {
  beforeEach(() => {
    runCommandWithTimeout.mockReset();
    hasBinary.mockReset();
    hasBinary.mockReturnValue(true);
  });

  it("invokes the correct lowercase docs MCP tool id", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const runtime = makeRuntime();

    await docsSearchCommand(["plugin", "allowlist"], runtime);

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const argv = runCommandWithTimeout.mock.calls[0][0] as string[];
    const toolUrl = argv.find((arg) => arg.includes("docs.openclaw.ai/mcp."));
    expect(toolUrl).toBe("https://docs.openclaw.ai/mcp.search_open_claw");
    expect(toolUrl).not.toMatch(/SearchOpenClaw/);
  });

  it("fails loudly when mcporter returns a JSON-RPC MCP error on stdout with exit 0", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      stdout: "MCP error -32602: Tool SearchOpenClaw not found",
      stderr: "",
    });
    const runtime = makeRuntime();

    await docsSearchCommand(["browser", "existing-session"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("MCP error -32602"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("renders successful results when no MCP error is present", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      stdout:
        "Title: Plugin allowlist\nLink: https://docs.openclaw.ai/plugins/allowlist\nContent: How to configure the allowlist.",
      stderr: "",
    });
    const runtime = makeRuntime();

    await docsSearchCommand(["plugin", "allowlist"], runtime);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });
});
