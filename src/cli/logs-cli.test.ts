import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn();

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: unknown[]) => callGatewayFromCli(...args),
  };
});

describe("logs cli", () => {
  afterEach(() => {
    callGatewayFromCli.mockReset();
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/moltbot.log",
      cursor: 1,
      size: 123,
      lines: ["raw line"],
      truncated: true,
      reset: true,
    });

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const { registerLogsCli } = await import("./logs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerLogsCli(program);

    await program.parseAsync(["logs"], { from: "user" });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(stdoutWrites.join("")).toContain("Log file:");
    expect(stdoutWrites.join("")).toContain("raw line");
    expect(stderrWrites.join("")).toContain("Log tail truncated");
    expect(stderrWrites.join("")).toContain("Log cursor reset");
  });

  it("warns when the output pipe closes", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/moltbot.log",
      lines: ["line one"],
    });

    const stderrWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const err = new Error("EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const { registerLogsCli } = await import("./logs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerLogsCli(program);

    await program.parseAsync(["logs"], { from: "user" });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(stderrWrites.join("")).toContain("output stdout closed");
  });
});
