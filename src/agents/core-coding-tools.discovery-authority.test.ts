import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { ensureTool } from "./utils/tools-manager.js";

vi.mock("./utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.clearAllMocks();
});

function createConfinedHostDiscoveryTools(params: {
  allowDiscoveryHelperProcesses: boolean;
  platform: NodeJS.Platform;
  workspaceOnly: boolean;
}) {
  return createCoreCodingTools({
    codingRoot: "/workspace",
    containmentRoot: "/workspace",
    includeBaseCodingTools: true,
    includeShellTools: true,
    allowDiscoveryHelperProcesses: params.allowDiscoveryHelperProcesses,
    workspaceOnly: params.workspaceOnly,
    readOnly: true,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: { scopeKey: "windows-discovery-test" },
    hostPlatform: params.platform,
  });
}

it.each(["darwin", "win32"] as const)(
  "does not advertise confined filesystem-only host discovery without a safe %s iterator",
  (platform) => {
    const tools = createConfinedHostDiscoveryTools({
      allowDiscoveryHelperProcesses: false,
      platform,
      workspaceOnly: true,
    });

    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["grep", "find", "ls"]),
    );
    expect(ensureTool).not.toHaveBeenCalled();
  },
);

it.each(["darwin", "win32"] as const)(
  "does not let helper-authorized %s discovery bypass workspace confinement",
  (platform) => {
    const tools = createConfinedHostDiscoveryTools({
      allowDiscoveryHelperProcesses: true,
      platform,
      workspaceOnly: true,
    });

    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["grep", "find", "ls"]),
    );
    expect(ensureTool).not.toHaveBeenCalled();
  },
);

it.each(["darwin", "win32"] as const)(
  "keeps helper-authorized unconfined %s host discovery registered",
  (platform) => {
    const tools = createConfinedHostDiscoveryTools({
      allowDiscoveryHelperProcesses: true,
      platform,
      workspaceOnly: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
    expect(ensureTool).not.toHaveBeenCalled();
  },
);

it("keeps confined Linux filesystem-only host discovery registered", () => {
  const tools = createConfinedHostDiscoveryTools({
    allowDiscoveryHelperProcesses: false,
    platform: "linux",
    workspaceOnly: true,
  });

  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
  expect(ensureTool).not.toHaveBeenCalled();
});

it.each([
  {
    name: "find",
    args: { pattern: "*.ts" },
    expected: "sentinel.ts",
  },
  {
    name: "grep",
    args: { pattern: "PROCESS_FREE_DISCOVERY_SENTINEL", literal: true },
    expected: "sentinel.ts:1: PROCESS_FREE_DISCOVERY_SENTINEL",
  },
  {
    name: "ls",
    args: {},
    expected: "sentinel.ts",
  },
])("runs $name without resolving a helper when process tools are excluded", async (testCase) => {
  const stateDir = tempDirs.make("openclaw-process-free-discovery-");
  const root = path.join(stateDir, "workspace");
  const outsideRoot = path.join(stateDir, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outsideRoot);
  await fs.writeFile(path.join(outsideRoot, "sentinel.ts"), "PROCESS_FREE_DISCOVERY_SENTINEL\n");
  const tools = createCoreCodingTools({
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    includeShellTools: true,
    allowDiscoveryHelperProcesses: false,
    workspaceOnly: false,
    readOnly: true,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: { scopeKey: "process-free-discovery-test" },
    hostPlatform: "win32",
  });
  const tool = tools.find((candidate) => candidate.name === testCase.name);
  if (!tool) {
    throw new Error(`expected ${testCase.name} tool`);
  }

  const result = await tool.execute(`process-free-${testCase.name}`, {
    ...testCase.args,
    path: testCase.name === "find" ? path.join("..", "outside") : outsideRoot,
  });

  expect(result.content[0]).toMatchObject({ type: "text", text: testCase.expected });
  expect(ensureTool).not.toHaveBeenCalled();
});
