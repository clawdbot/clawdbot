// Memory Core plugin module implements memory tool manager mock behavior.
import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import type { getMemorySearchManager } from "./tools.runtime.js";

type SearchImpl = (opts?: {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  qmdSearchModeOverride?: "query" | "search" | "vsearch";
  onDebug?: (debug: MemorySearchRuntimeDebug) => void;
  signal?: AbortSignal;
  [key: symbol]: ((action: "pause" | "resume" | "handoff") => void) | undefined;
}) => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};
type MemoryBackend = "builtin" | "qmd";
type MemoryManagerDebug = Awaited<ReturnType<typeof getMemorySearchManager>>["debug"];
type MemoryManagerParams = {
  cfg?: unknown;
  agentId?: string;
  purpose?: string;
  acquireLocalService?: unknown;
  withLease?: PluginStateLeaseRunner;
};

let backend: MemoryBackend = "builtin";
let resolvedBackend: MemoryBackend | undefined;
let workspaceDir = "/workspace";
let customStatus: Record<string, unknown> | undefined;
let searchImpl: SearchImpl = async () => [];
let closeImpl: () => Promise<void> = async () => {};
let getManagerImpl:
  | ((params: MemoryManagerParams) => Promise<{
      manager?: unknown;
      error?: string;
      debug?: MemoryManagerDebug;
    }>)
  | undefined;
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
  from: params.from ?? 1,
  lines: params.lines ?? 120,
});

const stubManager = {
  search: vi.fn(async (_query: string, opts?: Parameters<SearchImpl>[0]) => await searchImpl(opts)),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir,
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
    custom: customStatus,
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => await closeImpl()),
};

const getMemorySearchManagerMock = vi.fn(async (params: MemoryManagerParams) =>
  getManagerImpl ? await getManagerImpl(params) : { manager: stubManager },
);
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

vi.mock("./tools.runtime.js", () => ({
  resolveMemoryBackendConfig: ({
    cfg,
  }: {
    cfg?: { memory?: { backend?: string; qmd?: unknown } };
  }) => ({
    backend: resolvedBackend ?? backend,
    qmd: cfg?.memory?.qmd,
  }),
  getMemorySearchManager: getMemorySearchManagerMock,
  readAgentMemoryFile: readAgentMemoryFileMock,
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setResolvedMemoryBackend(next: MemoryBackend | undefined): void {
  resolvedBackend = next;
}

export function setMemoryWorkspaceDir(next: string): void {
  workspaceDir = next;
}

export function setMemoryCustomStatus(next: Record<string, unknown> | undefined): void {
  customStatus = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemoryCloseImpl(next: () => Promise<void>): void {
  closeImpl = next;
}

export function setMemorySearchManagerImpl(
  next: (params: MemoryManagerParams) => Promise<{
    manager?: unknown;
    error?: string;
    debug?: MemoryManagerDebug;
  }>,
): void {
  getManagerImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  searchImpl?: SearchImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
}): void {
  backend = overrides?.backend ?? "builtin";
  resolvedBackend = undefined;
  workspaceDir = "/workspace";
  customStatus = undefined;
  getManagerImpl = undefined;
  searchImpl = overrides?.searchImpl ?? (async () => []);
  closeImpl = async () => {};
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }));
  vi.clearAllMocks();
}

export function getMemorySearchManagerMockCalls(): number {
  return getMemorySearchManagerMock.mock.calls.length;
}

export function getMemorySyncMockCalls(): number {
  return stubManager.sync.mock.calls.length;
}

export function getMemoryCloseMockCalls(): number {
  return stubManager.close.mock.calls.length;
}

export function getMemorySearchManagerMockConfigs(): unknown[] {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params.cfg);
}

export function getMemorySearchManagerMockParams(): MemoryManagerParams[] {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params);
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
