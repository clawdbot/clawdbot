// Node identity CLI tests: read-only output of the node host device identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { defaultRuntime } from "../../runtime.js";
import { runNodeIdentityShow } from "./identity.js";

describe("runNodeIdentityShow", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  let stdout: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeJsonSpy: ReturnType<typeof vi.spyOn>;
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-identity-"));
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    stdout = [];
    logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    writeStdoutSpy = vi
      .spyOn(defaultRuntime, "writeStdout")
      .mockImplementation((value) => stdout.push(value));
    writeJsonSpy = vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value, space = 2) => {
      defaultRuntime.writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    });
  });

  afterEach(() => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    writeJsonSpy.mockRestore();
    writeStdoutSpy.mockRestore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("fails closed when no identity exists (never mints one)", () => {
    runNodeIdentityShow({});
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("writes deviceId and raw public key JSON to stdout", () => {
    const identity = loadOrCreateDeviceIdentity();
    runNodeIdentityShow({ json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(writeStdoutSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(stdout.join("")) as {
      deviceId: string;
      publicKey: string;
    };
    expect(parsed).toEqual({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    });
  });

  it("prints human-readable lines without --json", () => {
    const identity = loadOrCreateDeviceIdentity();
    runNodeIdentityShow({});
    expect(exitSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain(identity.deviceId);
    expect(output).toContain(publicKeyRawBase64UrlFromPem(identity.publicKeyPem));
  });
});
