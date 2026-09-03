import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { prepareWorkerTurnAttachments } from "./worker-turn-attachments.js";

describe("cloud attachment transfer confinement", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cloud-attachments-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function fixture() {
    const remote = path.join(await realpath(root), "remote");
    await mkdir(remote);
    const bytes = Buffer.from("%PDF-1.7\nreal original bytes");
    const saved = await saveMediaBuffer(
      bytes,
      "application/pdf",
      "inbound",
      bytes.length,
      "report.pdf",
    );
    const execute = async (command: WorkerWorkspaceCommand) =>
      await runCommandWithTimeout([...command.argv], {
        cwd: remote,
        input: command.input,
        timeoutMs: 10_000,
        signal: command.signal,
      });
    return {
      remote,
      bytes,
      execute,
      input: { timeoutMs: 5_000, media: [{ path: saved.path, contentType: "application/pdf" }] },
    };
  }

  it("removes incomplete files after a checksum failure without changing other workspace files", async () => {
    const { remote, execute, input } = await fixture();
    await writeFile(path.join(remote, "keep.txt"), "remote edits");
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) =>
      execute(
        command.input === undefined
          ? command
          : { ...command, input: Buffer.from("%PDF-1.7\ncorrupt bytes here!").toString("base64") },
      ),
    );
    await expect(
      prepareWorkerTurnAttachments({
        turn: input,
        remoteWorkspaceDir: remote,
        tunnel: { runWorkspaceCommand },
        assertCurrent: () => {},
      }),
    ).rejects.toThrow(/checksum|invalid attachment chunk/);
    expect(await readdir(remote)).toEqual(["keep.txt"]);
    expect(await readFile(path.join(remote, "keep.txt"), "utf8")).toBe("remote edits");
  });

  it("rejects a replaced upload directory without following its symlink during write or cleanup", async () => {
    const { remote, execute, input } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "outside");
    let initialized = false;
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      const result = await execute(command);
      if (!initialized) {
        initialized = true;
        const [directory] = await readdir(remote);
        await rename(path.join(remote, directory!), path.join(root, "original-upload"));
        await symlink(outside, path.join(remote, directory!), "dir");
      }
      return result;
    });
    await expect(
      prepareWorkerTurnAttachments({
        turn: input,
        remoteWorkspaceDir: remote,
        tunnel: { runWorkspaceCommand },
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("attachment directory changed");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside");
  });

  it("stops after claim loss and never uses a stale claim for cleanup", async () => {
    const { remote, execute, input } = await fixture();
    let current = true;
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      const result = await execute(command);
      current = false;
      return result;
    });
    await expect(
      prepareWorkerTurnAttachments({
        turn: input,
        remoteWorkspaceDir: remote,
        tunnel: { runWorkspaceCommand },
        assertCurrent: () => {
          if (!current) {
            throw new Error("lost claim");
          }
        },
      }),
    ).rejects.toThrow("lost claim");
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    const [directory] = await readdir(remote);
    expect(await readdir(path.join(remote, directory!))).toEqual([]);
  });

  it.each(["path", "url"] as const)(
    "reports unavailable local %s attachments without reading arbitrary host files",
    async (field) => {
      const { remote, input } = await fixture();
      const privatePath = path.join(root, "private.txt");
      await writeFile(privatePath, "not an admitted attachment");
      const runWorkspaceCommand = vi.fn();
      await expect(
        prepareWorkerTurnAttachments({
          turn: { ...input, media: [{ [field]: privatePath }] },
          remoteWorkspaceDir: remote,
          tunnel: { runWorkspaceCommand },
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("attach the file again");
      expect(runWorkspaceCommand).not.toHaveBeenCalled();
    },
  );

  it("uses a managed original URL when the runtime path was already staged on the Gateway", async () => {
    const { remote, input, execute, bytes } = await fixture();
    const note = await prepareWorkerTurnAttachments({
      turn: {
        ...input,
        media: [
          {
            path: path.join(root, "gateway-copy.pdf"),
            url: input.media[0]!.path,
            fileName: "original.pdf",
          },
        ],
      },
      remoteWorkspaceDir: remote,
      tunnel: { runWorkspaceCommand: execute },
      assertCurrent: () => {},
    });
    const [directory] = await readdir(remote);
    expect(note).toContain(directory);
    expect(await readFile(path.join(remote, directory!, "1-original.pdf"))).toEqual(bytes);
  });
});
