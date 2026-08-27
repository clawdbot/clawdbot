// Extension relay host-local token secret.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureExtensionRelayToken, readExtensionRelayToken } from "./relay-auth.js";

let stateDir = "";
let secretPath = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-")));
  secretPath = path.join(stateDir, "credentials", "browser-extension-relay.secret");
  env = { OPENCLAW_STATE_DIR: stateDir };
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("extension relay host-local secret", () => {
  it("returns null before the secret is created", () => {
    expect(readExtensionRelayToken(env)).toBeNull();
  });

  it("creates a 64-hex secret on ensure and persists it privately", async () => {
    const token = await ensureExtensionRelayToken(env);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(secretPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    { name: "private directory", mode: 0o700, symlink: false },
    { name: "0750 directory", mode: 0o750, symlink: false },
    { name: "symlinked directory", mode: 0o750, symlink: true },
  ])("reuses a valid key without mutating its $name", async ({ mode, symlink }) => {
    const first = await ensureExtensionRelayToken(env);
    const credentials = path.dirname(secretPath);
    if (process.platform !== "win32") {
      fs.chmodSync(credentials, mode);
    }
    if (symlink) {
      const target = path.join(stateDir, "credential-target");
      fs.renameSync(credentials, target);
      fs.symlinkSync(target, credentials, "junction");
    }
    const before = fs.statSync(secretPath);
    const bytes = fs.readFileSync(secretPath);
    await expect(ensureExtensionRelayToken(env)).resolves.toBe(first);
    expect(readExtensionRelayToken(env)).toBe(first);
    expect(fs.readFileSync(secretPath)).toEqual(bytes);
    expect(fs.statSync(secretPath)).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
    });
    expect(fs.lstatSync(credentials).isSymbolicLink()).toBe(symlink);
    if (process.platform !== "win32") {
      expect(fs.statSync(credentials).mode & 0o777).toBe(mode);
    }
  });

  it.each([
    { name: "simultaneous first callers", writerStarted: false, symlink: false },
    { name: "a writer already in progress", writerStarted: true, symlink: false },
    { name: "a writer in progress through a directory alias", writerStarted: true, symlink: true },
  ])("adopts the first writer's token with $name", async ({ writerStarted, symlink }) => {
    const writerToken = "a1".repeat(32);
    const credentials = path.dirname(secretPath);
    const target = symlink ? path.join(stateDir, "credential-target") : credentials;
    fs.mkdirSync(target, { mode: 0o700 });
    if (symlink) {
      fs.symlinkSync(target, credentials, "junction");
    }
    const fd = writerStarted
      ? fs.openSync(path.join(target, path.basename(secretPath)), "wx", 0o600)
      : undefined;
    try {
      const before = fd === undefined ? undefined : fs.fstatSync(fd);
      const tokens = Promise.all([ensureExtensionRelayToken(env), ensureExtensionRelayToken(env)]);
      // Hold the first writer's empty file until both callers have started.
      if (fd !== undefined) {
        fs.writeFileSync(fd, `${writerToken}\n`);
      }
      const [first, second] = await tokens;
      expect(second).toBe(first);
      expect(readExtensionRelayToken(env)).toBe(first);
      expect(fs.lstatSync(credentials).isSymbolicLink()).toBe(symlink);
      if (before) {
        expect(first).toBe(writerToken);
        expect(fs.readFileSync(secretPath, "utf8")).toBe(`${writerToken}\n`);
        expect(fs.statSync(secretPath)).toMatchObject({ dev: before.dev, ino: before.ino });
      }
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  });

  it("rejects creating a missing key through a symlinked credential directory", async () => {
    const target = path.join(stateDir, "credential-target");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.dirname(secretPath), "junction");
    await expect(ensureExtensionRelayToken(env)).rejects.toThrow("must not be a symlink");
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.lstatSync(path.dirname(secretPath)).isSymbolicLink()).toBe(true);
  });

  it.each([
    { name: "empty", content: "" },
    { name: "whitespace", content: " \n\t" },
    { name: "malformed", content: "not-a-relay-token\n" },
  ])("rejects a persistent $name secret without replacing it", async ({ content }) => {
    fs.mkdirSync(path.dirname(secretPath), { mode: 0o700 });
    fs.writeFileSync(secretPath, content, { flag: "wx", mode: 0o600 });
    const before = fs.statSync(secretPath);
    await expect(ensureExtensionRelayToken(env)).rejects.toMatchObject({
      cause: expect.any(Error),
    });
    expect(fs.readFileSync(secretPath, "utf8")).toBe(content);
    expect(fs.statSync(secretPath)).toMatchObject({ dev: before.dev, ino: before.ino });
  });

  it("gives different hosts (state dirs) different secrets", async () => {
    const a = await ensureExtensionRelayToken(env);
    const otherDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-2-")),
    );
    try {
      const b = await ensureExtensionRelayToken({ OPENCLAW_STATE_DIR: otherDir });
      expect(b).not.toBe(a);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
