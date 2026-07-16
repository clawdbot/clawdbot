import { describe, expect, it } from "vitest";

type SplitCommandLine = (
  value: string,
  platform?: string,
) => {
  command: string;
  args: string[];
};

async function loadSplitCommandLine(): Promise<SplitCommandLine> {
  const moduleUrl = new URL("./mcp-command-line.mjs", import.meta.url);
  return (await import(moduleUrl.href)).splitCommandLine as SplitCommandLine;
}

describe("mcp-command-line", () => {
  it("parses quoted Windows executable paths without dropping backslashes", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --stdio --flag "two words"',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--stdio", "--flag", "two words"],
    });
  });

  it("parses unquoted Windows executable paths without mangling backslashes", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine("C:\\Users\\alerl\\.local\\bin\\claude.exe --version", "win32");

    expect(parsed).toEqual({
      command: "C:\\Users\\alerl\\.local\\bin\\claude.exe",
      args: ["--version"],
    });
  });

  it("preserves unquoted Windows path arguments after the executable", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    const parsed = splitCommandLine(
      '"C:\\Program Files\\Claude\\claude.exe" --config C:\\Users\\me\\cfg.json',
      "win32",
    );

    expect(parsed).toEqual({
      command: "C:\\Program Files\\Claude\\claude.exe",
      args: ["--config", "C:\\Users\\me\\cfg.json"],
    });
  });

  it("rejects direct Windows wrapper-script commands with a helpful error", async () => {
    const splitCommandLine = await loadSplitCommandLine();
    expect(() =>
      splitCommandLine('"C:\\Users\\me\\bin\\claude-wrapper.cmd" --stdio', "win32"),
    ).toThrow(/Invoke wrapper scripts through their shell or interpreter instead/);
  });
});
