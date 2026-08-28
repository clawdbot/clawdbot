import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { isOpenClawManagedCodexThread } from "./session-catalog-provenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function writeRollout(payload: Record<string, unknown>): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-provenance-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "rollout.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload })}\n`);
  return file;
}

describe("Codex catalog provenance", () => {
  it("recognizes an OpenClaw-originated rollout even when Codex reports vscode", async () => {
    const file = await writeRollout({
      id: "managed-thread",
      originator: "openclaw",
      source: "vscode",
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "managed-thread", path: file } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("does not inspect a rollout outside the selected local sessions root", async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-provenance-root-"),
    );
    temporaryDirectories.push(sessionsRoot);
    const file = await writeRollout({
      id: "outside-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    await expect(
      isOpenClawManagedCodexThread(
        { id: "outside-managed-thread", path: file } as CodexThread,
        sessionsRoot,
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread(
        { id: "outside-managed-thread", path: file } as CodexThread,
        undefined,
      ),
    ).resolves.toBe(false);
  });

  it("does not follow a rollout symlink outside the selected local sessions root", async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-provenance-root-"),
    );
    temporaryDirectories.push(sessionsRoot);
    const outside = await writeRollout({
      id: "symlinked-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    const linked = path.join(sessionsRoot, "rollout.jsonl");
    await fs.symlink(outside, linked);

    await expect(
      isOpenClawManagedCodexThread(
        { id: "symlinked-managed-thread", path: linked } as CodexThread,
        sessionsRoot,
      ),
    ).resolves.toBe(false);
  });

  it("reads the complete session-meta line when embedded instructions exceed one chunk", async () => {
    const file = await writeRollout({
      id: "large-managed-thread",
      originator: "openclaw",
      base_instructions: { text: "x".repeat(80 * 1024) },
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "large-managed-thread", path: file } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("reads a compressed rollout when Codex retains the missing plain path", async () => {
    const file = await writeRollout({
      id: "compressed-managed-thread",
      originator: "openclaw",
      source: "vscode",
    });
    const compressed = `${file}.zst`;
    await fs.writeFile(compressed, zstdCompressSync(await fs.readFile(file)));
    await fs.rm(file);

    await expect(
      isOpenClawManagedCodexThread(
        {
          id: "compressed-managed-thread",
          path: file,
        } as CodexThread,
        path.dirname(file),
      ),
    ).resolves.toBe(true);
  });

  it("preserves native and mismatched rollouts", async () => {
    const native = await writeRollout({
      id: "native-thread",
      originator: "codex_cli_rs",
      source: "cli",
    });
    const mismatched = await writeRollout({
      id: "different-thread",
      originator: "openclaw",
      source: "vscode",
    });

    await expect(
      isOpenClawManagedCodexThread(
        { id: "native-thread", path: native } as CodexThread,
        path.dirname(native),
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread(
        { id: "requested-thread", path: mismatched } as CodexThread,
        path.dirname(mismatched),
      ),
    ).resolves.toBe(false);
    await expect(
      isOpenClawManagedCodexThread({ id: "missing-path" } as CodexThread, path.dirname(native)),
    ).resolves.toBe(false);
  });
});
