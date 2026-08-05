import { vi } from "vitest";
import type { ApplyPatchSummary } from "./apply-patch.js";
import "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type ApplyPatchOptions = {
  cwd: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  workspaceOnly?: boolean;
  signal?: AbortSignal;
};

type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
  noOp?: boolean;
};

type ApplyPatchTestApi = {
  applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult>;
};

export function createMemoryPatchSandbox(
  initialFiles: Record<string, string | Buffer> = {},
  options: { supportsExclusiveCreate?: boolean } = {},
) {
  const files = new Map<string, string | Buffer>(
    Object.entries(initialFiles).map(([filePath, contents]) => [`/sandbox/${filePath}`, contents]),
  );
  const writeFile = vi.fn(async ({ filePath, data }) => {
    files.set(filePath, Buffer.isBuffer(data) ? Buffer.from(data) : data);
  });
  const createFileExclusive = vi.fn(async ({ filePath, data }) => {
    if (files.has(filePath)) {
      return "exists" as const;
    }
    files.set(filePath, Buffer.isBuffer(data) ? Buffer.from(data) : data);
    return "created" as const;
  });
  const mkdirp = vi.fn(async () => {});
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }),
    readFile: async ({ filePath }) => {
      const contents = files.get(filePath);
      return typeof contents === "string"
        ? Buffer.from(contents, "utf8")
        : Buffer.from(contents ?? "");
    },
    writeFile,
    ...(options.supportsExclusiveCreate === false ? {} : { createFileExclusive }),
    remove: async ({ filePath }) => {
      files.delete(filePath);
    },
    rename: async ({ from, to }) => {
      const contents = files.get(from);
      if (contents !== undefined) {
        files.set(to, contents);
        files.delete(from);
      }
    },
    stat: async ({ filePath }) => {
      const contents = files.get(filePath);
      return contents === undefined
        ? null
        : { type: "file", size: Buffer.byteLength(contents), mtimeMs: 0 };
    },
    mkdirp,
  };
  return {
    files,
    bridge,
    writeFile,
    createFileExclusive,
    mkdirp,
    options: {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge,
      },
    },
  };
}

function getTestApi(): ApplyPatchTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.applyPatchTestApi")
  ];
  if (!api) {
    throw new Error("apply patch test API is unavailable");
  }
  return api as ApplyPatchTestApi;
}

export async function applyPatch(
  input: string,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  return await getTestApi().applyPatch(input, options);
}
