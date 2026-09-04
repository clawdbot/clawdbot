import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  removePathWithinRoot,
  resolvePreferredOpenClawTmpDir,
  root,
} from "openclaw/plugin-sdk/file-access-runtime";

const RESOURCE_HANDLE_PREFIX = "openclaw:computer-resource:v1:";
const RESOURCE_ROOT_NAME = "cua-computer-resources";
const MAX_RESOURCE_TREE_ENTRIES = 10_000;

type DirectoryResourceKind = "browser-download" | "recording";
type ResourceKind = DirectoryResourceKind | "file";

type ResourceEntry = {
  kind: ResourceKind;
  relativePath: string;
};

type SafeRoot = Awaited<ReturnType<typeof root>>;

export type CuaExecutionResources = {
  createDirectory(kind: DirectoryResourceKind): Promise<{ handle: string; path: string }>;
  resolveFiles(handles: readonly string[]): Promise<string[]>;
  validateDirectoryTree(handle: string): Promise<string>;
  captureFiles(handle: string): Promise<string[]>;
  discard(handle: string): Promise<void>;
  dispose(discard: boolean): Promise<void>;
};

export function createLazyCuaExecutionResources(): CuaExecutionResources {
  let resourcesPromise: Promise<CuaExecutionResources> | undefined;
  const resources = () => (resourcesPromise ??= createCuaExecutionResources());
  return {
    createDirectory: async (label) => await (await resources()).createDirectory(label),
    resolveFiles: async (handles) => await (await resources()).resolveFiles(handles),
    validateDirectoryTree: async (handle) =>
      await (await resources()).validateDirectoryTree(handle),
    captureFiles: async (handle) => await (await resources()).captureFiles(handle),
    discard: async (handle) => await (await resources()).discard(handle),
    dispose: async (discard) => {
      if (resourcesPromise) {
        await (await resourcesPromise).dispose(discard);
      }
    },
  };
}

function resourceError(message: string): Error {
  return new Error(`COMPUTER_INVALID_RESOURCE: ${message}`);
}

function newHandle(): string {
  return `${RESOURCE_HANDLE_PREFIX}${randomUUID()}`;
}

function safeLabel(value: string): string {
  return value.replaceAll(/[^a-z0-9-]/giu, "-").slice(0, 32) || "resource";
}

async function requireEntry(
  resources: Map<string, ResourceEntry>,
  executionRoot: SafeRoot,
  handle: string,
  kind: ResourceKind,
): Promise<{ entry: ResourceEntry; path: string }> {
  if (!handle.startsWith(RESOURCE_HANDLE_PREFIX)) {
    throw resourceError("malformed resource handle");
  }
  const entry = resources.get(handle);
  if (!entry || entry.kind !== kind) {
    throw resourceError("resource handle is unknown in this provider execution");
  }
  let stat;
  let resolved;
  try {
    stat = await executionRoot.stat(entry.relativePath);
    resolved = await executionRoot.resolve(entry.relativePath);
  } catch (error) {
    throw resourceError(`resource is no longer a safe ${kind}: ${String(error)}`);
  }
  if (stat.isSymbolicLink || (kind === "file" ? !stat.isFile : !stat.isDirectory)) {
    throw resourceError(`resource is no longer a regular ${kind}`);
  }
  return { entry, path: resolved };
}

async function createCuaExecutionResources(): Promise<CuaExecutionResources> {
  const preferredTmpRoot = await root(resolvePreferredOpenClawTmpDir(), {
    hardlinks: "reject",
    mode: 0o700,
    symlinks: "reject",
  });
  await preferredTmpRoot.mkdir(RESOURCE_ROOT_NAME);
  const baseRoot = await root(await preferredTmpRoot.resolve(RESOURCE_ROOT_NAME), {
    hardlinks: "reject",
    mode: 0o700,
    symlinks: "reject",
  });
  const executionDirectory = `execution-${randomUUID()}`;
  await baseRoot.mkdir(executionDirectory);
  const executionPath = await baseRoot.resolve(executionDirectory);
  const executionRoot = await root(executionPath, {
    hardlinks: "reject",
    mode: 0o700,
    symlinks: "reject",
  });
  const resources = new Map<string, ResourceEntry>();
  const handlesByPath = new Map<string, string>();
  let disposed = false;

  const assertActive = () => {
    if (disposed) {
      throw resourceError("provider execution is closed");
    }
  };

  const register = (kind: ResourceKind, relativePath: string): string => {
    const existing = handlesByPath.get(relativePath);
    if (existing) {
      return existing;
    }
    const handle = newHandle();
    resources.set(handle, { kind, relativePath });
    handlesByPath.set(relativePath, handle);
    return handle;
  };

  const removeHandle = async (handle: string) => {
    const entry = resources.get(handle);
    if (!entry) {
      return;
    }
    await removePathWithinRoot({
      rootDir: executionRoot.rootReal,
      relativePath: entry.relativePath,
      recursive: true,
      force: true,
    });
    resources.delete(handle);
    handlesByPath.delete(entry.relativePath);
  };

  return {
    async createDirectory(kind) {
      assertActive();
      const relativePath = `${safeLabel(kind)}-${randomUUID()}`;
      await executionRoot.mkdir(relativePath);
      return {
        handle: register(kind, relativePath),
        path: await executionRoot.resolve(relativePath),
      };
    },
    async resolveFiles(handles) {
      assertActive();
      return await Promise.all(
        handles.map(
          async (handle) => (await requireEntry(resources, executionRoot, handle, "file")).path,
        ),
      );
    },
    async validateDirectoryTree(handle) {
      assertActive();
      const directory = await requireEntry(resources, executionRoot, handle, "recording");
      let visited = 0;
      const visit = async (relativePath: string): Promise<void> => {
        for (const child of await executionRoot.list(relativePath, { withFileTypes: true })) {
          visited += 1;
          if (visited > MAX_RESOURCE_TREE_ENTRIES) {
            throw resourceError("resource tree is too large");
          }
          if (child.isSymbolicLink || (!child.isDirectory && !child.isFile)) {
            throw resourceError("resource tree contains an unsupported entry");
          }
          const childPath = path.join(relativePath, child.name);
          await executionRoot.resolve(childPath);
          if (child.isDirectory) {
            await visit(childPath);
          }
        }
      };
      await visit(directory.entry.relativePath);
      return directory.path;
    },
    async captureFiles(handle) {
      assertActive();
      const directory = await requireEntry(resources, executionRoot, handle, "browser-download");
      const handles: string[] = [];
      for (const child of await executionRoot.list(directory.entry.relativePath, {
        withFileTypes: true,
      })) {
        if (child.isSymbolicLink || !child.isFile) {
          continue;
        }
        const relativePath = path.join(directory.entry.relativePath, child.name);
        await executionRoot.resolve(relativePath);
        handles.push(register("file", relativePath));
      }
      return handles;
    },
    async discard(handle) {
      assertActive();
      await removeHandle(handle);
    },
    async dispose(discard) {
      if (disposed) {
        return;
      }
      disposed = true;
      resources.clear();
      handlesByPath.clear();
      if (discard) {
        await removePathWithinRoot({
          rootDir: baseRoot.rootReal,
          relativePath: executionDirectory,
          recursive: true,
          force: true,
        });
      }
    },
  };
}
