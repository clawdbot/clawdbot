import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexProtocolExportArgs,
  resolveCodexAppServerProtocolSource,
  resolveCodexProtocolCargoTargetDir,
  resolveCodexProtocolMinFreeBytes,
  resolveCodexProtocolPnpmCommand,
  validateCodexProtocolGenerationHeadroom,
} from "../../scripts/lib/codex-app-server-protocol-source.js";
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
  it("uses the app-server protocol export binary instead of compiling the full codex cli", () => {
    expect(buildCodexProtocolExportArgs("/codex/codex-rs/Cargo.toml", "/tmp/protocol")).toEqual([
      "run",
      "--manifest-path",
      "/codex/codex-rs/Cargo.toml",
      "-p",
      "codex-app-server-protocol",
      "--bin",
      "export",
      "--",
      "--out",
      "/tmp/protocol",
      "--experimental",
    ]);
  });

  it("fails before cargo protocol generation when local disk headroom is too low", () => {
    expect(() =>
      validateCodexProtocolGenerationHeadroom({
        freeBytes: 6 * 1024 * 1024 * 1024,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        pathLabel: "/repo",
      }),
    ).toThrow(/Run this check on Crabbox\/Testbox/);
  });

  it("allows an explicit local disk headroom override", () => {
    expect(resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "0" })).toBe(
      0,
    );
    expect(() =>
      validateCodexProtocolGenerationHeadroom({
        freeBytes: 1,
        minFreeBytes: 0,
        pathLabel: "/repo",
      }),
    ).not.toThrow();
  });

  it("rejects malformed local disk headroom overrides", () => {
    expect(() =>
      resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "nope" }),
    ).toThrow(/non-negative byte count/);
  });

  it("checks the Codex workspace target dir by default", () => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", {})).toBe(
      path.join("/codex", "codex-rs", "target"),
    );
  });

  it("checks an explicit Cargo target dir override", () => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", { CARGO_TARGET_DIR: "/cache/target" })).toBe(
      path.resolve("/cache/target"),
    );
  });

  it("resolves relative Cargo target dir overrides from the Codex checkout", () => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", { CARGO_TARGET_DIR: "target-cache" })).toBe(
      path.join("/codex", "target-cache"),
    );
  });

  it("checks Cargo's build target dir override", () => {
    expect(
      resolveCodexProtocolCargoTargetDir("/codex", {
        CARGO_BUILD_TARGET_DIR: "/cache/build-target",
      }),
    ).toBe(path.resolve("/cache/build-target"));
  });

  it("prefers Cargo's target dir override over the build config env override", () => {
    expect(
      resolveCodexProtocolCargoTargetDir("/codex", {
        CARGO_BUILD_TARGET_DIR: "/cache/build-target",
        CARGO_TARGET_DIR: "/cache/target",
      }),
    ).toBe(path.resolve("/cache/target"));
  });

  it("wraps Windows pnpm formatting through cmd.exe without shell mode", () => {
    expect(
      resolveCodexProtocolPnpmCommand(
        ["exec", "oxfmt", "--write", "--threads=1", String.raw`C:\tmp\generated types`],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          npmExecPath: String.raw`C:\Program Files\nodejs\pnpm.cmd`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\pnpm.cmd" exec oxfmt --write --threads=1 "C:\tmp\generated types""`,
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

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
