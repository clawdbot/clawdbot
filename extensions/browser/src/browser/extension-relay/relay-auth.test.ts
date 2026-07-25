// Extension relay host-local token secret.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureExtensionRelayToken,
  readExtensionRelayToken,
  resolveExtensionRelayToken,
} from "./relay-auth.js";

let stateDir = "";
const prevStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-")));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});
afterEach(() => {
  if (prevStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = prevStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("extension relay host-local secret", () => {
  it("returns null before the secret is created", () => {
    expect(readExtensionRelayToken()).toBeNull();
    expect(resolveExtensionRelayToken()).toBeNull();
  });

  it("creates a 64-hex secret on ensure and persists it privately", () => {
    const token = ensureExtensionRelayToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const secretPath = path.join(stateDir, "credentials", "browser-extension-relay.secret");
    expect(fs.existsSync(secretPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
  });

  it("is stable across calls (does not rotate on read)", () => {
    const first = ensureExtensionRelayToken();
    expect(ensureExtensionRelayToken()).toBe(first);
    expect(readExtensionRelayToken()).toBe(first);
  });

  it("gives different hosts (state dirs) different secrets", () => {
    const a = ensureExtensionRelayToken();
    const otherDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-2-")),
    );
    try {
      const b = ensureExtensionRelayToken({ ...process.env, OPENCLAW_STATE_DIR: otherDir });
      expect(b).not.toBe(a);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
