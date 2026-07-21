import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { spawnCommand } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition } from "./find.js";

vi.mock("../../../process/exec.js", () => ({
  spawnCommand: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type MockChild = ChildProcessWithoutNullStreams & {
  stdout: PassThrough;
  stderr: PassThrough;
  killMock: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  vi.clearAllMocks();
});

function createChild(): MockChild {
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill,
    killMock: kill,
  }) as unknown as MockChild;
}

it("rejects partial fd output when fd exits with an error", async () => {
  const child = createChild();
  vi.mocked(spawnCommand).mockReturnValue(child as never);
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
  child.stdout.end("/workspace/partial.ts\n");
  child.stderr.end("fd failed while reading subtree\n");
  child.emit("close", 2, null);

  await expect(result).rejects.toThrow("fd failed while reading subtree");
});

it("keeps multibyte stderr intact when pipe chunks split a character", async () => {
  const child = createChild();
  vi.mocked(spawnCommand).mockReturnValue(child as never);
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
  const stderrBytes = Buffer.from("fd 失败：权限被拒绝\n");
  child.stdout.end();
  // Split inside the first multibyte character to mimic a pipe chunk boundary.
  child.stderr.write(stderrBytes.subarray(0, 5));
  child.stderr.end(stderrBytes.subarray(5));
  child.emit("close", 2, null);

  await expect(result).rejects.toThrow("fd 失败：权限被拒绝");
});

it.each(["stdout", "stderr"] as const)(
  "rejects and stops fd when %s emits an error",
  async (stream) => {
    const child = createChild();
    vi.mocked(spawnCommand).mockReturnValue(child as never);
    vi.mocked(ensureTool).mockResolvedValue("fd");

    const tool = createFindToolDefinition("/workspace");
    const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    child[stream].emit("error", new Error(`${stream} EPIPE`));

    await expect(result).rejects.toThrow(`${stream} EPIPE`);
    expect(child.killMock).toHaveBeenCalledOnce();
  },
);

it.each([
  { name: "inside a repository", gitBoundary: true, expected: false },
  { name: "outside a repository", gitBoundary: false, expected: true },
])("sets --no-require-git only $name", async ({ gitBoundary, expected }) => {
  const tempDir = tempDirs.make("openclaw-find-fd-");
  const searchPath = path.join(tempDir, "nested");
  await fs.mkdir(searchPath, { recursive: true });
  if (gitBoundary) {
    await fs.writeFile(path.join(tempDir, ".git"), "gitdir: /tmp/example\n");
  }

  const child = createChild();
  vi.mocked(spawnCommand).mockReturnValue(child as never);
  vi.mocked(ensureTool).mockResolvedValue("fd");
  const tool = createFindToolDefinition(tempDir);
  const result = tool.execute(
    "call-git-boundary",
    { pattern: "AGENTS.md", path: searchPath },
    undefined,
    undefined,
    {} as never,
  );
  await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await result;

  const args = vi.mocked(spawnCommand).mock.calls[0]?.[0] as string[];
  expect(args.includes("--no-require-git")).toBe(expected);
});
