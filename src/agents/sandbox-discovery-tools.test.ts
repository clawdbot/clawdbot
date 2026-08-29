import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createHostWorkspaceDiscoveryOperations,
  createSandboxDiscoveryOperations,
} from "./sandbox-discovery-tools.js";
import {
  SANDBOX_FS_DIRECTORY_MAX_ENTRIES,
  supportsSandboxFsDiscovery,
  type SandboxFsDiscoveryBridge,
} from "./sandbox/fs-bridge.discovery.js";
import { createFindToolDefinition } from "./sessions/tools/find.js";
import { createGrepToolDefinition } from "./sessions/tools/grep.js";
import { createLsToolDefinition } from "./sessions/tools/ls.js";
import { createContainerWorkspaceSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createBridge(
  listDirectory: SandboxFsDiscoveryBridge["listDirectory"],
): SandboxFsDiscoveryBridge {
  return {
    resolvePath: ({ filePath }) => ({ relativePath: filePath, containerPath: filePath }),
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    mkdirp: async () => {},
    remove: async () => {},
    rename: async () => {},
    stat: async () => ({ type: "directory", size: 0, mtimeMs: 0 }),
    listDirectory,
  };
}

function createVirtualBridge(params: {
  directories: Record<string, Array<{ name: string; type: "file" | "directory" | "other" }>>;
  files: Record<string, string>;
}): SandboxFsDiscoveryBridge {
  return {
    ...createBridge(async ({ filePath }) => params.directories[filePath] ?? []),
    readFile: async ({ filePath }) => Buffer.from(params.files[filePath] ?? ""),
    stat: async ({ filePath }) =>
      Object.hasOwn(params.files, filePath)
        ? {
            type: "file",
            size: Buffer.byteLength(params.files[filePath] ?? ""),
            mtimeMs: 0,
          }
        : Object.hasOwn(params.directories, filePath)
          ? { type: "directory", size: 0, mtimeMs: 0 }
          : null,
  };
}

function abortableListing() {
  let observedSignal: AbortSignal | undefined;
  const listDirectory = vi.fn(
    ({ signal }: { signal?: AbortSignal }) =>
      new Promise<[]>((_resolve, reject) => {
        observedSignal = signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  return { listDirectory, observedSignal: () => observedSignal };
}

describe("sandbox discovery operation cancellation", () => {
  it("stops bridge traversal when find reaches its deadline", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createFindToolDefinition("/workspace", {
      operations: operations.find,
      timeoutMs: 5,
    });

    await expect(
      tool.execute("find", { pattern: "**/*" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Find timed out after 5ms");
    expect(listing.observedSignal()?.aborted).toBe(true);
  });

  it("stops bridge traversal when grep reaches its deadline", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createGrepToolDefinition("/workspace", {
      operations: operations.grep,
      timeoutMs: 5,
    });

    await expect(
      tool.execute("grep", { pattern: "value" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Grep timed out after 5ms");
    expect(listing.observedSignal()?.aborted).toBe(true);
  });

  it("passes caller cancellation through ls to the bridge", async () => {
    const listing = abortableListing();
    const operations = createSandboxDiscoveryOperations(createBridge(listing.listDirectory));
    const tool = createLsToolDefinition("/workspace", { operations: operations.ls });
    const controller = new AbortController();
    const result = tool.execute("ls", {}, controller.signal, undefined, {} as never);
    await vi.waitFor(() => expect(listing.listDirectory).toHaveBeenCalledOnce());

    controller.abort();

    await expect(result).rejects.toThrow("Operation aborted");
    expect(listing.observedSignal()).toBe(controller.signal);
    expect(listing.observedSignal()?.aborted).toBe(true);
  });
});

describe("sandbox ls entry classification", () => {
  it("keeps entry types attached to concurrent listing results", async () => {
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolveSecondStarted) => {
      markSecondStarted = resolveSecondStarted;
    });
    const listDirectory = vi.fn(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith("first")) {
        await secondStarted;
        return [{ name: "outward-link", type: "other" as const }];
      }
      markSecondStarted?.();
      return [{ name: "nested", type: "directory" as const }];
    });
    const operations = createSandboxDiscoveryOperations(createBridge(listDirectory));

    const [first, second] = await Promise.all([
      operations.ls.readdir("/workspace/first"),
      operations.ls.readdir("/workspace/second"),
    ]);

    expect(first).toEqual([{ name: "outward-link", isDirectory: false }]);
    expect(second).toEqual([{ name: "nested", isDirectory: true }]);
  });
});

describe("sandbox grep line boundaries", () => {
  it("does not treat a terminal line ending as an extra empty line", async () => {
    const bridge = {
      ...createBridge(async () => [
        { name: "empty.txt", type: "file" as const },
        { name: "lines.txt", type: "file" as const },
      ]),
      readFile: async ({ filePath }: { filePath: string }) =>
        Buffer.from(filePath.endsWith("empty.txt") ? "" : "first\n\nlast\n"),
    };
    const operations = createSandboxDiscoveryOperations(bridge);

    await expect(
      operations.grep.search?.({
        searchPath: "/workspace",
        pattern: "^$",
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        filePath: "/workspace/lines.txt",
        lineNumber: 2,
        lineText: "",
      },
    ]);
  });
});

describe("sandbox discovery ignore rules", () => {
  it("inherits workspace ignore rules across host and container path spellings", async () => {
    const workspaceDir = tempDirs.make("openclaw-discovery-path-spellings-");
    await fs.mkdir(path.join(workspaceDir, "src"));
    await fs.writeFile(path.join(workspaceDir, ".gitignore"), "src/ignored.ts\n");
    await fs.writeFile(path.join(workspaceDir, "src", "ignored.ts"), "needle\n");
    await fs.writeFile(path.join(workspaceDir, "src", "visible.ts"), "needle\n");
    const bridge = createContainerWorkspaceSandboxFsBridge(workspaceDir);
    if (!supportsSandboxFsDiscovery(bridge)) {
      throw new Error("expected discovery bridge");
    }
    const operations = createSandboxDiscoveryOperations(bridge, { rootPath: workspaceDir });

    await expect(
      operations.find.glob("*.ts", "/workspace/src", { ignore: [], limit: 10 }),
    ).resolves.toEqual(["/workspace/src/visible.ts"]);
    await expect(
      operations.grep.search?.({
        searchPath: "/workspace/src",
        pattern: "needle",
        literal: true,
        limit: 10,
      }),
    ).resolves.toEqual([
      { filePath: "/workspace/src/visible.ts", lineNumber: 1, lineText: "needle" },
    ]);
  });

  it("applies parent ignore files when searching a workspace subtree", async () => {
    const bridge = createVirtualBridge({
      directories: {
        "/workspace": [
          { name: ".gitignore", type: "file" },
          { name: "src", type: "directory" },
        ],
        "/workspace/src": [
          { name: "generated", type: "directory" },
          { name: "visible.ts", type: "file" },
        ],
        "/workspace/src/generated": [{ name: "hidden.ts", type: "file" }],
      },
      files: {
        "/workspace/.gitignore": "src/generated/**\n",
        "/workspace/src/generated/hidden.ts": "needle\n",
        "/workspace/src/visible.ts": "needle\n",
      },
    });
    const operations = createSandboxDiscoveryOperations(bridge, { rootPath: "/workspace" });

    await expect(
      operations.find.glob("*.ts", "/workspace/src", { ignore: [], limit: 10 }),
    ).resolves.toEqual(["/workspace/src/visible.ts"]);
    await expect(
      operations.grep.search?.({
        searchPath: "/workspace/src",
        pattern: "needle",
        literal: true,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        filePath: "/workspace/src/visible.ts",
        lineNumber: 1,
        lineText: "needle",
      },
    ]);
  });

  it("keeps fd and ripgrep ignore files scoped to their matching tools", async () => {
    const bridge = createVirtualBridge({
      directories: {
        "/workspace": [
          { name: ".fdignore", type: "file" },
          { name: ".rgignore", type: "file" },
          { name: "fd-hidden.txt", type: "file" },
          { name: "rg-hidden.txt", type: "file" },
        ],
      },
      files: {
        "/workspace/.fdignore": "fd-hidden.txt\n",
        "/workspace/.rgignore": "rg-hidden.txt\n",
        "/workspace/fd-hidden.txt": "needle\n",
        "/workspace/rg-hidden.txt": "needle\n",
      },
    });
    const operations = createSandboxDiscoveryOperations(bridge, { rootPath: "/workspace" });

    await expect(
      operations.find.glob("*.txt", "/workspace", { ignore: [], limit: 10 }),
    ).resolves.toEqual(["/workspace/rg-hidden.txt"]);
    await expect(
      operations.grep.search?.({
        searchPath: "/workspace",
        pattern: "needle",
        literal: true,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        filePath: "/workspace/fd-hidden.txt",
        lineNumber: 1,
        lineText: "needle",
      },
    ]);
  });

  it("does not let ignore negations reopen hard-excluded directories", async () => {
    const bridge = createVirtualBridge({
      directories: {
        "/workspace": [
          { name: ".gitignore", type: "file" },
          { name: ".git", type: "directory" },
          { name: "node_modules", type: "directory" },
          { name: "visible.txt", type: "file" },
        ],
        "/workspace/.git": [{ name: "hidden.txt", type: "file" }],
        "/workspace/node_modules": [{ name: "hidden.txt", type: "file" }],
      },
      files: {
        "/workspace/.gitignore": "!.git/\n!.git/**\n!node_modules/\n!node_modules/**\n",
        "/workspace/.git/hidden.txt": "needle\n",
        "/workspace/node_modules/hidden.txt": "needle\n",
        "/workspace/visible.txt": "needle\n",
      },
    });
    const listDirectory = vi.fn(bridge.listDirectory);
    bridge.listDirectory = listDirectory;
    const operations = createSandboxDiscoveryOperations(bridge, { rootPath: "/workspace" });

    await expect(
      operations.find.glob("*.txt", "/workspace", { ignore: [], limit: 10 }),
    ).resolves.toEqual(["/workspace/visible.txt"]);
    await expect(
      operations.grep.search?.({
        searchPath: "/workspace",
        pattern: "needle",
        literal: true,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        filePath: "/workspace/visible.txt",
        lineNumber: 1,
        lineText: "needle",
      },
    ]);
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/workspace/.git" }),
    );
    expect(listDirectory).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/workspace/node_modules" }),
    );
  });
});

describe("host workspace discovery bounds", () => {
  it.runIf(process.platform === "linux")(
    "rejects a real directory over the discovery entry limit",
    async () => {
      const stateDir = tempDirs.make("openclaw-host-discovery-");
      try {
        const names = Array.from(
          { length: SANDBOX_FS_DIRECTORY_MAX_ENTRIES + 1 },
          (_, index) => `entry-${index}`,
        );
        for (let start = 0; start < names.length; start += 500) {
          await Promise.all(
            names
              .slice(start, start + 500)
              .map((name) => fs.writeFile(path.join(stateDir, name), "")),
          );
        }
        const operations = createHostWorkspaceDiscoveryOperations(stateDir);

        await expect(operations.ls.readdir(stateDir)).rejects.toThrow("entry limit");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
