import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { fsHandlers } from "./fs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function call(
  params: Record<string, unknown>,
  context: Record<string, unknown> = {
    getRuntimeConfig: () => ({}),
    nodeRegistry: { get: vi.fn(), invoke: vi.fn() },
  },
  client: Record<string, unknown> = { connect: { scopes: ["operator.admin"] } },
) {
  const respond = vi.fn();
  await fsHandlers["fs.listDir"]?.({ params, respond, context, client } as never);
  return respond.mock.calls[0];
}

const writeClient = { connect: { scopes: ["operator.write"] } };

function workspaceContext(workspace: string) {
  return {
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "main", default: true, workspace }] },
    }),
    nodeRegistry: { get: vi.fn(), invoke: vi.fn() },
  };
}

describe("fs.listDir", () => {
  it.each(["operator.admin", "operator.write"])(
    "reopens the exact returned directory path with %s",
    async (scope) => {
      const root = fsSync.realpathSync(tempDirs.make("openclaw-fs-path-identity-"));
      await fs.mkdir(path.join(root, "Project", "ordinary-child"), { recursive: true });
      await fs.mkdir(path.join(root, "Project ", "spaced-child"), { recursive: true });
      const context = workspaceContext(root);
      const client = { connect: { scopes: [scope] } };
      const [listed, initial] = expectDefined(
        await call({ path: root }, context, client),
        "parent directory listing",
      );
      expect(listed).toBe(true);
      const selected = expectDefined(
        (initial as FsListDirResult).entries.find((entry) => entry.name === "Project "),
        "directory with a trailing space",
      );
      const [opened, result] = expectDefined(
        await call({ path: selected.path }, context, client),
        "selected directory listing",
      );
      expect(opened).toBe(true);
      expect(result).toMatchObject({
        path: selected.path,
        entries: [{ name: "spaced-child", path: path.join(selected.path, "spaced-child") }],
      });
    },
  );

  it("lists only directories, visible before hidden, in byte order", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    await fs.mkdir(path.join(root, "zeta"));
    await fs.mkdir(path.join(root, "alpha"));
    await fs.mkdir(path.join(root, ".hidden"));
    await fs.writeFile(path.join(root, "file.txt"), "not a directory");

    const [ok, result] = expectDefined(
      await call({ path: root }),
      "await call({ path: root }) test invariant",
    );
    expect(ok).toBe(true);
    expect(result).toEqual({
      path: root,
      parent: path.dirname(root),
      home: os.homedir(),
      entries: [
        { name: "alpha", path: path.join(root, "alpha") },
        { name: "zeta", path: path.join(root, "zeta") },
        { name: ".hidden", path: path.join(root, ".hidden"), hidden: true },
      ],
    });
  });

  it("follows directory symlinks and skips file or broken symlinks", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    await fs.mkdir(path.join(root, "real"));
    await fs.writeFile(path.join(root, "plain.txt"), "file");
    fsSync.symlinkSync(path.join(root, "real"), path.join(root, "linked-dir"));
    fsSync.symlinkSync(path.join(root, "plain.txt"), path.join(root, "linked-file"));
    fsSync.symlinkSync(path.join(root, "missing"), path.join(root, "broken"));

    const [ok, result] = expectDefined(
      await call({ path: root }),
      "await call({ path: root }) test invariant",
    );
    expect(ok).toBe(true);
    expect((result as { entries: Array<{ name: string }> }).entries.map((e) => e.name)).toEqual([
      "linked-dir",
      "real",
    ]);
  });

  it("defaults to the host home directory", async () => {
    const [ok, result] = expectDefined(await call({}), "await call({}) test invariant");
    expect(ok).toBe(true);
    expect((result as { path: string }).path).toBe(os.homedir());
    expect((result as { home: string }).home).toBe(os.homedir());
  });

  it("rejects relative paths and invalid params", async () => {
    const [relativeOk, , relativeError] = expectDefined(
      await call({ path: "relative/dir" }),
      'await call({ path: "relative/dir" }) test invariant',
    );
    expect(relativeOk).toBe(false);
    expect(String((relativeError as { message?: string })?.message)).toContain("absolute");

    const [invalidOk] = expectDefined(
      await call({ path: 42 }),
      "await call({ path: 42 }) test invariant",
    );
    expect(invalidOk).toBe(false);
  });

  it("reports missing directories as request errors", async () => {
    const root = tempDirs.make("openclaw-fs-listdir-");
    const missing = path.join(root, "does-not-exist");
    const [ok, , error] = expectDefined(
      await call({ path: missing }),
      "missing directory response",
    );
    expect(ok).toBe(false);
    const message = (error as { message?: string })?.message ?? "";
    expect(message).toContain(`ENOENT: no such file or directory, scandir '${missing}'`);
    expect(message).toMatch(/ \| ENOENT$/u);
    expect(message).not.toMatch(/^Error:/u);
  });

  it("allows write-scoped browsing inside a configured workspace", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const nested = path.join(workspace, "packages");
    await fs.mkdir(nested);

    const [ok, result] = expectDefined(
      await call({ path: nested }, workspaceContext(workspace), writeClient),
      "write-scoped workspace listing",
    );

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: nested, parent: workspace });
  });

  it("defaults write-scoped browsing to the workspace root and clamps its parent", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");

    const [ok, result] = expectDefined(
      await call({}, workspaceContext(workspace), writeClient),
      "write-scoped workspace root listing",
    );

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: workspace });
    expect(result).not.toHaveProperty("parent");
  });

  it("rejects write-scoped browsing outside configured workspaces", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const outside = tempDirs.make("openclaw-fs-outside-");

    const [ok, , error] = expectDefined(
      await call({ path: outside }, workspaceContext(workspace), writeClient),
      "write-scoped outside listing",
    );

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining("operator.admin") });
  });

  it("rejects write-scoped browsing through a workspace symlink that escapes", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const outside = tempDirs.make("openclaw-fs-outside-");
    const escape = path.join(workspace, "escape");
    fsSync.symlinkSync(outside, escape);

    const [ok, , error] = expectDefined(
      await call({ path: escape }, workspaceContext(workspace), writeClient),
      "write-scoped symlink escape listing",
    );

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: expect.stringContaining("operator.admin") });
  });

  it("keeps missing workspace descendants as filesystem errors instead of scope errors", async () => {
    const workspace = tempDirs.make("openclaw-fs-workspace-");
    const missing = path.join(workspace, "missing", "child");

    const [ok, , error] = expectDefined(
      await call({ path: missing }, workspaceContext(workspace), writeClient),
      "write-scoped missing descendant listing",
    );

    expect(ok).toBe(false);
    const message = (error as { message?: string })?.message ?? "";
    expect(message).toContain(`ENOENT: no such file or directory, scandir '${missing}'`);
    expect(message).toMatch(/ \| ENOENT$/u);
    expect(message).not.toMatch(/^Error:/u);
  });

  it("routes node listings through the connected node capability", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      payloadJSON: JSON.stringify({
        path: "/Users/peter",
        home: "/Users/peter",
        entries: [{ name: "Projects", path: "/Users/peter/Projects" }],
      }),
    });
    const context = {
      getRuntimeConfig: () => ({}),
      nodeRegistry: {
        get: vi.fn().mockReturnValue({
          connId: "conn-1",
          pairingGeneration: "generation-1",
          nodeId: "macbook",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["system.run", "fs.listDir"],
        }),
        invoke,
      },
    };

    const [ok, result] = expectDefined(
      await call({ nodeId: "macbook" }, context),
      'await call({ nodeId: "macbook" }, context) test invariant',
    );

    expect(ok).toBe(true);
    expect(result).toMatchObject({ path: "/Users/peter", home: "/Users/peter" });
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "macbook",
      expectedConnId: "conn-1",
      expectedPairingGeneration: "generation-1",
      command: "fs.listDir",
      params: {},
    });
  });

  it("rejects node listings blocked by the live command policy", async () => {
    const invoke = vi.fn();
    const context = {
      getRuntimeConfig: () => ({ gateway: { nodes: { commands: { deny: ["fs.listDir"] } } } }),
      nodeRegistry: {
        get: vi.fn().mockReturnValue({
          connId: "conn-1",
          nodeId: "macbook",
          platform: "macos",
          deviceFamily: "Mac",
          commands: ["fs.listDir"],
        }),
        invoke,
      },
    };

    const [ok, , error] = expectDefined(
      await call({ nodeId: "macbook" }, context),
      'await call({ nodeId: "macbook" }, context) test invariant',
    );

    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { command: "fs.listDir", reason: "command not allowlisted" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects disconnected and directory-browse-incompatible nodes", async () => {
    const disconnected = expectDefined(
      await call({ nodeId: "offline" }, { nodeRegistry: { get: vi.fn(), invoke: vi.fn() } }),
      'await call( { nodeId: "offline" }, { nodeRegistry: { get: vi.fn(), in... test invariant',
    );
    expect(expectDefined(disconnected[0], "disconnected[0] test invariant")).toBe(false);
    expect(expectDefined(disconnected[2], "disconnected[2] test invariant")).toMatchObject({
      code: "UNAVAILABLE",
    });

    const unsupported = expectDefined(
      await call(
        { nodeId: "old-node" },
        {
          nodeRegistry: {
            get: vi.fn().mockReturnValue({ connId: "conn-2", commands: ["system.run"] }),
            invoke: vi.fn(),
          },
        },
      ),
      'await call( { nodeId: "old-node" }, { nodeRegistry: { get: vi.fn().mo... test invariant',
    );
    expect(expectDefined(unsupported[0], "unsupported[0] test invariant")).toBe(false);
    expect(expectDefined(unsupported[2], "unsupported[2] test invariant")).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("does not support"),
    });
  });
});
