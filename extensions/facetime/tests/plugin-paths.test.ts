import { describe, expect, it, vi } from "vitest";
import { ensureCaptureBinary, ensureHelperArtifacts } from "../src/plugin-paths.js";

const homebrewDir = "/opt/homebrew/opt/openclaw-facetime/libexec";

function installedAccess() {
  return vi.fn(async (path: string) => {
    if (!path.startsWith(homebrewDir) && !path.endsWith("FaceTimeHelper.dylib")) {
      throw new Error("missing");
    }
  });
}

function installedReadFile() {
  return vi.fn(async (path: string) => {
    if (path.endsWith("native-protocol.env")) {
      return "NATIVE_PROTOCOL_VERSION=1\n";
    }
    return `${"b".repeat(64)}\n`;
  });
}

describe("plugin paths", () => {
  it("uses the Homebrew capture helper", async () => {
    await expect(
      ensureCaptureBinary({
        access: installedAccess() as any,
        readFile: installedReadFile() as any,
      }),
    ).resolves.toBe(`${homebrewDir}/facetime-audio-capture`);
  });

  it("fails with the install command when no compatible package exists", async () => {
    await expect(
      ensureCaptureBinary({
        access: vi.fn().mockRejectedValue(new Error("missing")) as any,
        readFile: installedReadFile() as any,
      }),
    ).rejects.toThrow("brew install openclaw/tap/openclaw-facetime");
  });

  it("rejects an incompatible native protocol", async () => {
    const readFile = vi.fn(async (path: string) =>
      path.endsWith("native-protocol.env") ? "NATIVE_PROTOCOL_VERSION=2\n" : `${"b".repeat(64)}\n`,
    );
    await expect(
      ensureCaptureBinary({ access: installedAccess() as any, readFile: readFile as any }),
    ).rejects.toThrow("Compatible FaceTime native helpers are not installed");
  });

  it("stages and validates the installed injected helper", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await expect(
      ensureHelperArtifacts({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        access: installedAccess() as any,
        readFile: installedReadFile() as any,
      }),
    ).resolves.toMatchObject({ buildId: "b".repeat(64), ipcKey: "b".repeat(64) });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/stage-helper.sh", "--if-needed"],
      { timeoutMs: 120_000 },
    );
  });
});
