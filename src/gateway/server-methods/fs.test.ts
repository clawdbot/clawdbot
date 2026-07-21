import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsHandlers } from "./fs.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-listdir-"));
  tempRoots.push(root);
  // macOS tmpdir is a /var -> /private/var symlink; the handler returns resolved paths.
  return await fs.realpath(root);
}

async function call(
  params: Record<string, unknown>,
  context: Record<string, unknown> = {
    nodeRegistry: { get: vi.fn(), invoke: vi.fn() },
  },
) {
  const respond = vi.fn();
  await fsHandlers["fs.listDir"]?.({ params, respond, context } as never);
  return respond.mock.calls[0];
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("fs.listDir", () => {
  it("lists only directories, visible before hidden, in byte order", async () => {
    const root = await makeTempRoot();
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
    const root = await makeTempRoot();
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
    const root = await makeTempRoot();
    const [ok, , error] = expectDefined(
      await call({ path: path.join(root, "does-not-exist") }),
      'await call({ path: path.join(root, "does-not-exist") }) test invariant',
    );
    expect(ok).toBe(false);
    expect((error as { message?: string })?.message).toContain("ENOENT");
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
      getRuntimeConfig: () => ({ gateway: { nodes: { denyCommands: ["fs.listDir"] } } }),
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
