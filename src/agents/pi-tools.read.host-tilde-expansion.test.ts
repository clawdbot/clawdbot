import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
};

type CapturedWriteOperations = {
  mkdir: (dir: string) => Promise<void>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  editOps: undefined as CapturedEditOperations | undefined,
  writeOps: undefined as CapturedWriteOperations | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.editOps = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
    createWriteTool: (_cwd: string, options?: { operations?: CapturedWriteOperations }) => {
      mocks.writeOps = options?.operations;
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./pi-tools.read.js");

const osHome = () => process.env.HOME ?? os.homedir();
const toTildePath = (absolutePath: string) => absolutePath.replace(osHome(), "~");

function readEditOps(): CapturedEditOperations {
  if (!mocks.editOps) {
    throw new Error("expected captured edit operations");
  }
  return mocks.editOps;
}

function readWriteOps(): CapturedWriteOperations {
  if (!mocks.writeOps) {
    throw new Error("expected captured write operations");
  }
  return mocks.writeOps;
}

async function expectMissingPath(operation: Promise<unknown>) {
  let error: NodeJS.ErrnoException | undefined;
  try {
    await operation;
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }
  expect(error?.code).toBe("ENOENT");
}

describe("host tool tilde expansion (non-workspace mode)", () => {
  const tempDirs: string[] = [];

  const createTempDir = async (prefix: string, parent = osHome()) => {
    const dir = await fs.mkdtemp(path.join(parent, prefix));
    tempDirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("edit readFile expands ~ to the OS home directory", async () => {
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    createHostWorkspaceEditTool(dir, { workspaceOnly: false });
    const content = await readEditOps().readFile(toTildePath(testFile));

    expect(content.toString("utf8")).toBe("hello");
  });

  it("edit access expands ~ to the OS home directory", async () => {
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "test.txt");
    await fs.writeFile(testFile, "hello", "utf8");

    createHostWorkspaceEditTool(dir, { workspaceOnly: false });

    await expect(readEditOps().access(toTildePath(testFile))).resolves.toBeUndefined();
  });

  it("write writeFile expands ~ to the OS home directory", async () => {
    const dir = await createTempDir("openclaw-tilde-test-write-");
    const testFile = path.join(dir, "tilde-write-test.txt");

    createHostWorkspaceWriteTool(dir, { workspaceOnly: false });
    await readWriteOps().writeFile(toTildePath(testFile), "written via tilde");

    expect(await fs.readFile(testFile, "utf8")).toBe("written via tilde");
  });

  it("write mkdir expands ~ to the OS home directory", async () => {
    const dir = await createTempDir("openclaw-tilde-test-mkdir-");
    const newDir = path.join(dir, "subdir");

    createHostWorkspaceWriteTool(dir, { workspaceOnly: false });
    await readWriteOps().mkdir(toTildePath(newDir));

    expect((await fs.stat(newDir)).isDirectory()).toBe(true);
  });

  it("ignores OPENCLAW_HOME for write operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-write-");
    const testFile = path.join(dir, "os-home-write.txt");
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    await readWriteOps().writeFile(toTildePath(testFile), "written via os home");

    expect(await fs.readFile(testFile, "utf8")).toBe("written via os home");
    await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
  });

  it("ignores OPENCLAW_HOME for mkdir operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-mkdir-");
    const newDir = path.join(dir, "os-home-subdir");
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    await readWriteOps().mkdir(toTildePath(newDir));

    expect((await fs.stat(newDir)).isDirectory()).toBe(true);
    await expectMissingPath(fs.access(path.join(openclawHome, path.basename(newDir))));
  });

  it("ignores OPENCLAW_HOME for readFile operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "os-home-read.txt");
    await fs.writeFile(testFile, "OS home content", "utf8");
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });
    const content = await readEditOps().readFile(toTildePath(testFile));

    expect(content.toString("utf8")).toBe("OS home content");
    await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
  });

  it("ignores OPENCLAW_HOME for access operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "os-home-access.txt");
    await fs.writeFile(testFile, "exists", "utf8");
    vi.stubEnv("OPENCLAW_HOME", openclawHome);

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });

    await expect(readEditOps().access(toTildePath(testFile))).resolves.toBeUndefined();
    await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
  });
});
