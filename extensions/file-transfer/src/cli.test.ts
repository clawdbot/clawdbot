import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mutateConfigMock, prompterMock, readSnapshotMock } = vi.hoisted(() => ({
  mutateConfigMock: vi.fn(),
  prompterMock: {
    intro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    outro: vi.fn(),
  },
  readSnapshotMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: mutateConfigMock,
  readConfigFileSnapshotForWrite: readSnapshotMock,
}));

vi.mock("openclaw/plugin-sdk/setup-runtime", () => ({
  createClackPrompter: () => prompterMock,
}));

import { registerFileTransferCli } from "./cli.js";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function snapshot(
  pluginConfig: Record<string, unknown>,
  gateway?: Record<string, unknown>,
  pluginsIncludePath?: string,
) {
  return {
    snapshot: {
      valid: true,
      hash: "hash",
      path: "/tmp/openclaw.json",
      ...(pluginsIncludePath
        ? {
            includeProvenance: [
              {
                path: ["plugins"],
                kind: "single",
                hasSiblingOverrides: false,
                targetPath: pluginsIncludePath,
              },
            ],
          }
        : {}),
      sourceConfig: {
        ...(gateway ? { gateway } : {}),
        plugins: { entries: { "file-transfer": { config: pluginConfig } } },
      },
    },
    writeOptions: {},
  };
}

afterEach(() => {
  mutateConfigMock.mockReset();
  readSnapshotMock.mockReset();
  for (const mock of Object.values(prompterMock)) {
    mock.mockReset();
  }
  process.exitCode = undefined;
  if (stdinIsTtyDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  vi.restoreAllMocks();
});

describe("file-transfer approvals migration CLI", () => {
  it("reports unresolved legacy permissions as JSON without prompting or writing", async () => {
    readSnapshotMock.mockResolvedValue(
      snapshot({ nodes: { Shared: { allowReadPaths: ["/tmp/report-*.txt"] } } }),
    );
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const program = new Command();
    registerFileTransferCli(program);

    await program.parseAsync([
      "node",
      "openclaw",
      "file-transfer",
      "approvals",
      "migrate",
      "--json",
    ]);

    expect(JSON.parse(writes.join(""))).toMatchObject({
      status: "needs-input",
      changed: false,
      command: "openclaw file-transfer approvals migrate",
    });
    expect(process.exitCode).toBe(2);
    expect(mutateConfigMock).not.toHaveBeenCalled();
  });

  it("warns about downgrade recovery before applying the interactive migration", async () => {
    readSnapshotMock.mockResolvedValue(
      snapshot({ nodes: { Shared: { allowReadPaths: ["/tmp/report.txt"] } } }),
    );
    prompterMock.select.mockResolvedValue("exact");
    prompterMock.confirm.mockResolvedValue(true);
    mutateConfigMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        mutate({});
      },
    );
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const program = new Command();
    registerFileTransferCli(program);

    await program.parseAsync(["node", "openclaw", "file-transfer", "approvals", "migrate"]);

    expect(prompterMock.note).toHaveBeenCalledWith(
      expect.stringContaining("restore the adjacent config backup"),
      "Downgrade",
    );
    expect(mutateConfigMock).toHaveBeenCalledOnce();
  });

  it("requires an explicit decision for wildcard-selector permissions", async () => {
    readSnapshotMock.mockResolvedValue(
      snapshot({ nodes: { "*": { allowReadPaths: ["/tmp/**"] } } }),
    );
    prompterMock.select.mockResolvedValue("keep-glob");
    prompterMock.confirm.mockResolvedValue(false);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const program = new Command();
    registerFileTransferCli(program);

    await program.parseAsync(["node", "openclaw", "file-transfer", "approvals", "migrate"]);

    expect(prompterMock.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "* · read · /tmp/**" }),
    );
    expect(mutateConfigMock).not.toHaveBeenCalled();
  });

  it("reports the backup belonging to an included plugins config", async () => {
    const pluginsPath = "/tmp/included-plugins.json";
    readSnapshotMock.mockResolvedValue(
      snapshot(
        { nodes: { Shared: { allowReadPaths: ["/tmp/report.txt"] } } },
        undefined,
        pluginsPath,
      ),
    );
    prompterMock.select.mockResolvedValue("exact");
    prompterMock.confirm.mockResolvedValue(true);
    mutateConfigMock.mockImplementation(
      async ({ mutate }: { mutate: (draft: Record<string, unknown>) => void }) => {
        mutate({});
      },
    );
    const backupStat = { ino: 1, mtimeMs: 1, size: 1 } as Awaited<ReturnType<typeof fs.stat>>;
    vi.spyOn(fs, "stat")
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(backupStat);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const program = new Command();
    registerFileTransferCli(program);

    await program.parseAsync(["node", "openclaw", "file-transfer", "approvals", "migrate"]);

    expect(fs.stat).toHaveBeenNthCalledWith(1, `${pluginsPath}.bak`);
    expect(fs.stat).toHaveBeenNthCalledWith(2, `${pluginsPath}.bak`);
    expect(prompterMock.outro).toHaveBeenCalledWith(expect.stringContaining(`${pluginsPath}.bak`));
  });

  it("refuses to mutate local config in remote Gateway mode", async () => {
    readSnapshotMock.mockResolvedValue(
      snapshot({ nodes: { Shared: { allowReadPaths: ["/tmp/report.txt"] } } }, { mode: "remote" }),
    );
    const program = new Command();
    registerFileTransferCli(program);

    await expect(
      program.parseAsync(["node", "openclaw", "file-transfer", "approvals", "migrate", "--json"]),
    ).rejects.toThrow("must run on the Gateway host");
    expect(mutateConfigMock).not.toHaveBeenCalled();
  });
});
