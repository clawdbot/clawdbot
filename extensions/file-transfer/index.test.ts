import { afterAll, describe, expect, it, vi } from "vitest";
import pluginEntry from "./index.js";

function rejectRuntimeImport(moduleName: string) {
  return () => {
    throw new Error(`${moduleName} imported during descriptor registration`);
  };
}

vi.mock("./src/node-host/file-fetch.js", rejectRuntimeImport("node-host/file-fetch"));
vi.mock("./src/node-host/dir-list.js", rejectRuntimeImport("node-host/dir-list"));
vi.mock("./src/node-host/dir-fetch.js", rejectRuntimeImport("node-host/dir-fetch"));
vi.mock("./src/node-host/file-write.js", rejectRuntimeImport("node-host/file-write"));
vi.mock("./src/tools/file-fetch-tool.js", rejectRuntimeImport("tools/file-fetch-tool"));
vi.mock("./src/tools/dir-list-tool.js", rejectRuntimeImport("tools/dir-list-tool"));
vi.mock("./src/tools/dir-fetch-tool.js", rejectRuntimeImport("tools/dir-fetch-tool"));
vi.mock("./src/tools/file-write-tool.js", rejectRuntimeImport("tools/file-write-tool"));
vi.mock("./src/shared/node-invoke-policy.js", rejectRuntimeImport("shared/node-invoke-policy"));

afterAll(() => {
  vi.doUnmock("./src/node-host/file-fetch.js");
  vi.doUnmock("./src/node-host/dir-list.js");
  vi.doUnmock("./src/node-host/dir-fetch.js");
  vi.doUnmock("./src/node-host/file-write.js");
  vi.doUnmock("./src/tools/file-fetch-tool.js");
  vi.doUnmock("./src/tools/dir-list-tool.js");
  vi.doUnmock("./src/tools/dir-fetch-tool.js");
  vi.doUnmock("./src/tools/file-write-tool.js");
  vi.doUnmock("./src/shared/node-invoke-policy.js");
  vi.resetModules();
});

describe("file-transfer plugin entry", () => {
  it("registers static command and tool descriptors without importing runtime handlers", () => {
    const registerNodeInvokePolicy = vi.fn();
    const registerTool = vi.fn();

    pluginEntry.register({
      registerNodeInvokePolicy,
      registerTool,
    } as never);

    expect(pluginEntry.nodeHostCommands?.map((entry) => entry.command)).toEqual([
      "file.fetch",
      "dir.list",
      "dir.fetch",
      "file.write",
    ]);
    expect(registerNodeInvokePolicy).toHaveBeenCalledTimes(1);
    expect(registerNodeInvokePolicy.mock.calls[0]?.[0].commands).toEqual([
      "file.fetch",
      "dir.list",
      "dir.fetch",
      "file.write",
    ]);
    expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "file_fetch",
      "dir_list",
      "dir_fetch",
      "file_write",
    ]);
  });

  it("fails closed if the lazy policy module cannot load", async () => {
    const registerNodeInvokePolicy = vi.fn();
    const registerTool = vi.fn();
    const invokeNode = vi.fn();

    pluginEntry.register({
      registerNodeInvokePolicy,
      registerTool,
    } as never);

    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0];
    await expect(
      policy.handle({
        nodeId: "node-1",
        command: "file.fetch",
        params: { path: "/tmp/a.txt" },
        config: {},
        pluginConfig: {},
        client: null,
        invokeNode,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "PLUGIN_POLICY_UNAVAILABLE",
      unavailable: true,
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});
