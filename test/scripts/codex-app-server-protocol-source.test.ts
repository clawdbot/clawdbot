import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexAppServerProtocolSource } from "../../scripts/lib/codex-app-server-protocol-source.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const originalOpenClawCodexRepo = process.env.OPENCLAW_CODEX_REPO;

afterEach(() => {
  if (originalOpenClawCodexRepo === undefined) {
    delete process.env.OPENCLAW_CODEX_REPO;
  } else {
    process.env.OPENCLAW_CODEX_REPO = originalOpenClawCodexRepo;
  }
});

describe("codex app-server protocol source resolver", () => {
  it("uses OPENCLAW_CODEX_REPO when provided", async () => {
    const root = createTempDir("openclaw-protocol-source-root-");
    const codexRepo = createTempDir("openclaw-protocol-source-codex-");
    createProtocolSchema(codexRepo);
    process.env.OPENCLAW_CODEX_REPO = codexRepo;

    await expect(resolveCodexAppServerProtocolSource(root)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });

  it("finds the primary checkout sibling from a git worktree", async () => {
    const parentDir = createTempDir("openclaw-protocol-source-parent-");
    const primaryOpenClaw = path.join(parentDir, "openclaw");
    const codexRepo = path.join(parentDir, "codex");
    const worktreeRoot = createTempDir("openclaw-protocol-source-worktree-");
    fs.mkdirSync(path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness"), {
      recursive: true,
    });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness")}\n`,
    );
    createProtocolSchema(codexRepo);
    delete process.env.OPENCLAW_CODEX_REPO;

    await expect(resolveCodexAppServerProtocolSource(worktreeRoot)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });
});

function createProtocolSchema(codexRepo: string): void {
  fs.mkdirSync(path.join(codexRepo, "codex-rs/app-server-protocol/schema/typescript"), {
    recursive: true,
  });
}
