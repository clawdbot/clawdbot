/**
 * Tests host workspace file operation path handling.
 * Non-workspace mode should resolve home paths before passing through guarded
 * edit and write operations.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type CapturedEditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  statFile: (absolutePath: string) => Promise<unknown>;
  access: (absolutePath: string) => Promise<void>;
};

type CapturedWriteOperations = {
  mkdir: (dir: string) => Promise<void>;
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  statFile: (absolutePath: string) => Promise<unknown>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  editOps: undefined as CapturedEditOperations | undefined,
  writeOps: undefined as CapturedWriteOperations | undefined,
}));

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
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

const {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createSandboxedEditTool,
  createSandboxedWriteTool,
} = await import("./agent-tools.read.js");

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

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
      await readWriteOps().writeFile(toTildePath(testFile), "written via os home");

      expect(await fs.readFile(testFile, "utf8")).toBe("written via os home");
      await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
    });
  });

  it("ignores OPENCLAW_HOME for mkdir operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-mkdir-");
    const newDir = path.join(dir, "os-home-subdir");

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
      await readWriteOps().mkdir(toTildePath(newDir));

      expect((await fs.stat(newDir)).isDirectory()).toBe(true);
      await expectMissingPath(fs.access(path.join(openclawHome, path.basename(newDir))));
    });
  });

  it("ignores OPENCLAW_HOME for readFile operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "os-home-read.txt");
    await fs.writeFile(testFile, "OS home content", "utf8");

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });
      const content = await readEditOps().readFile(toTildePath(testFile));

      expect(content.toString("utf8")).toBe("OS home content");
      await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
    });
  });

  it("ignores OPENCLAW_HOME for access operations", async () => {
    const openclawHome = await createTempDir("openclaw-home-override-", os.tmpdir());
    const dir = await createTempDir("openclaw-tilde-test-edit-");
    const testFile = path.join(dir, "os-home-access.txt");
    await fs.writeFile(testFile, "exists", "utf8");

    await withEnvAsync({ OPENCLAW_HOME: openclawHome }, async () => {
      createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });

      await expect(readEditOps().access(toTildePath(testFile))).resolves.toBeUndefined();
      await expectMissingPath(fs.access(path.join(openclawHome, path.basename(testFile))));
    });
  });
});

describe("createHostWorkspaceEditTool host access mapping", () => {
  it.runIf(process.platform !== "win32")(
    "silently passes access for outside-workspace paths so readFile reports the real error",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-access-test-"));
      try {
        const workspaceDir = path.join(tmpDir, "workspace");
        const outsideDir = path.join(tmpDir, "outside");
        const linkDir = path.join(workspaceDir, "escape");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret", "utf8");
        await fs.symlink(outsideDir, linkDir);

        createHostWorkspaceEditTool(workspaceDir, { workspaceOnly: true });

        // Let the guarded read surface the real workspace-escape error instead of
        // having the upstream library replace an access error with "File not found".
        await expect(
          readEditOps().access(path.join(workspaceDir, "escape", "secret.txt")),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

describe("file mutation verification operations", () => {
  it("provides readback and stat operations to host writes and edits", () => {
    createHostWorkspaceWriteTool("/workspace", { workspaceOnly: false });

    expect(readWriteOps().readFile).toBeTypeOf("function");
    expect(readWriteOps().statFile).toBeTypeOf("function");

    createHostWorkspaceEditTool("/workspace", { workspaceOnly: false });

    expect(readEditOps().readFile).toBeTypeOf("function");
    expect(readEditOps().statFile).toBeTypeOf("function");
  });

  it("provides readback and stat operations to sandbox writes and edits", () => {
    const params = {
      root: "/workspace",
      bridge: {} as SandboxFsBridge,
    };
    createSandboxedWriteTool(params);

    expect(readWriteOps().readFile).toBeTypeOf("function");
    expect(readWriteOps().statFile).toBeTypeOf("function");

    createSandboxedEditTool(params);

    expect(readEditOps().readFile).toBeTypeOf("function");
    expect(readEditOps().statFile).toBeTypeOf("function");
  });
});
