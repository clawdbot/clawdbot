import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, vi, type Mock } from "vitest";

type ExecDockerRawFn = typeof import("./docker.js").execDockerRaw;
type OpenRootFileFn = typeof import("./fs-bridge-path-safety.runtime.js").openRootFile;
type ExecDockerArgs = Parameters<ExecDockerRawFn>[0];
type ExecDockerRawMock = Mock<ExecDockerRawFn>;
type OpenRootFileMock = Mock<OpenRootFileFn>;
type FsBridgeHoisted = {
  execDockerRaw: ExecDockerRawMock;
  openRootFile: OpenRootFileMock;
};

let actualOpenRootFile: OpenRootFileFn | undefined;

const hoisted = vi.hoisted(
  (): FsBridgeHoisted => ({
    execDockerRaw: vi.fn(),
    openRootFile: vi.fn(),
  }),
);

vi.mock("./docker.js", () => ({
  execDockerRaw: (args: ExecDockerArgs, opts?: Parameters<ExecDockerRawFn>[1]) =>
    hoisted.execDockerRaw(args, opts),
}));

vi.mock("./fs-bridge-path-safety.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./fs-bridge-path-safety.runtime.js")>(
    "./fs-bridge-path-safety.runtime.js",
  );
  actualOpenRootFile = actual.openRootFile;
  return {
    ...actual,
    openRootFile: (params: Parameters<OpenRootFileFn>[0]) => hoisted.openRootFile(params),
  };
});

import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

let createSandboxFsBridgeImpl: typeof import("./fs-bridge.js").createSandboxFsBridge;

async function loadFreshFsBridgeModuleForTest() {
  vi.resetModules();
  vi.doMock("./docker.js", () => ({
    execDockerRaw: (args: ExecDockerArgs, opts?: Parameters<ExecDockerRawFn>[1]) =>
      hoisted.execDockerRaw(args, opts),
  }));
  vi.doMock("./fs-bridge-path-safety.runtime.js", async () => {
    const actual = await vi.importActual<typeof import("./fs-bridge-path-safety.runtime.js")>(
      "./fs-bridge-path-safety.runtime.js",
    );
    actualOpenRootFile = actual.openRootFile;
    return {
      ...actual,
      openRootFile: (params: Parameters<OpenRootFileFn>[0]) => hoisted.openRootFile(params),
    };
  });
  ({ createSandboxFsBridge: createSandboxFsBridgeImpl } = await import("./fs-bridge.js"));
}

export function createSandboxFsBridge(
  ...args: Parameters<typeof import("./fs-bridge.js").createSandboxFsBridge>
) {
  if (!createSandboxFsBridgeImpl) {
    throw new Error("fs-bridge test harness not initialized");
  }
  return createSandboxFsBridgeImpl(...args);
}

export const mockedExecDockerRaw: ExecDockerRawMock = hoisted.execDockerRaw;
export const mockedOpenRootFile: OpenRootFileMock = hoisted.openRootFile;
const DOCKER_SCRIPT_INDEX = 5;
const DOCKER_FIRST_SCRIPT_ARG_INDEX = 7;

export function getDockerScript(args: string[]): string {
  return args[DOCKER_SCRIPT_INDEX] ?? "";
}

export function getDockerArg(args: string[], position: number): string {
  return args[DOCKER_FIRST_SCRIPT_ARG_INDEX + position - 1] ?? "";
}

export function getScriptsFromCalls(): string[] {
  return mockedExecDockerRaw.mock.calls.map(([args]) => getDockerScript(args));
}

export function findCallByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerScript(args).includes(fragment));
}

export function findCallByDockerArg(position: number, value: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerArg(args, position) === value);
}

export function findCallsByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.filter(([args]) =>
    getDockerScript(args).includes(fragment),
  );
}

export function dockerExecResult(stdout: string) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code: 0,
  };
}

export function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides: {
      containerName: "openclaw-sbx-test",
      ...overrides,
    },
    dockerOverrides: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
    },
  });
}

export async function createSeededSandboxFsBridge(
  stateDir: string,
  params?: {
    rootFileName?: string;
    rootContents?: string;
    nestedFileName?: string;
    nestedContents?: string;
  },
) {
  const workspaceDir = path.join(stateDir, "workspace");
  await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, params?.rootFileName ?? "from.txt"),
    params?.rootContents ?? "hello",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "nested", params?.nestedFileName ?? "file.txt"),
    params?.nestedContents ?? "bye",
    "utf8",
  );
  const bridge = createSandboxFsBridge({
    sandbox: createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    }),
  });
  return { workspaceDir, bridge };
}

export async function withTempDir<T>(
  prefix: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function installDockerReadMock(params?: { canonicalPath?: string }) {
  const canonicalPath = params?.canonicalPath;
  mockedExecDockerRaw.mockImplementation(async (args) => {
    const script = getDockerScript(args);
    if (script.includes('readlink -f -- "$cursor"')) {
      return dockerExecResult(`${canonicalPath ?? getDockerArg(args, 1)}\n`);
    }
    if (script.includes('stat -c "%F|%s|%Y"')) {
      return dockerExecResult("regular file|1|2");
    }
    if (script.includes('cat -- "$1"')) {
      return dockerExecResult("content");
    }
    if (script.includes("mktemp")) {
      return dockerExecResult("/workspace/.openclaw-write-b.txt.ABC123\n");
    }
    return dockerExecResult("");
  });
}

export async function createHostEscapeFixture(stateDir: string) {
  const workspaceDir = path.join(stateDir, "workspace");
  const outsideDir = path.join(stateDir, "outside");
  const outsideFile = path.join(outsideDir, "secret.txt");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(outsideFile, "classified");
  return { workspaceDir, outsideFile };
}

export async function expectMkdirpAllowsExistingDirectory(params?: {
  forceBoundaryIoFallback?: boolean;
}) {
  await withTempDir("openclaw-fs-bridge-mkdirp-", async (stateDir) => {
    const workspaceDir = path.join(stateDir, "workspace");
    const nestedDir = path.join(workspaceDir, "memory", "kemik");
    await fs.mkdir(nestedDir, { recursive: true });

    if (params?.forceBoundaryIoFallback) {
      mockedOpenRootFile.mockImplementationOnce(async () => ({
        ok: false,
        reason: "io",
        error: Object.assign(new Error("EISDIR"), { code: "EISDIR" }),
      }));
    }

    const bridge = createSandboxFsBridge({
      sandbox: createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
      }),
    });

    await expect(bridge.mkdirp({ filePath: "memory/kemik" })).resolves.toBeUndefined();

    const mkdirCall = mockedExecDockerRaw.mock.calls.find(
      ([args]) =>
        getDockerScript(args).includes("operation = sys.argv[1]") &&
        getDockerArg(args, 1) === "mkdirp",
    );
    if (!mkdirCall) {
      throw new Error("expected docker mkdirp call");
    }
    const mountRoot = getDockerArg(mkdirCall[0], 2);
    const relativePath = getDockerArg(mkdirCall[0], 3);
    expect(mountRoot).toBe("/workspace");
    expect(relativePath).toBe("memory/kemik");
  });
}

export function installFsBridgeTestHarness() {
  beforeEach(async () => {
    await loadFreshFsBridgeModuleForTest();
    mockedExecDockerRaw.mockClear();
    mockedOpenRootFile.mockClear();
    if (actualOpenRootFile) {
      mockedOpenRootFile.mockImplementation(actualOpenRootFile);
    }
    installDockerReadMock();
  });
}
