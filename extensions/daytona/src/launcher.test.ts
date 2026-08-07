import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const launcherPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "daytona-exec-launcher.mjs",
);

const loadLauncher = async () =>
  (await import(pathToFileURL(launcherPath).href)) as {
    decodePayload: (argv: string[]) => unknown;
    shellEscape: (value: string) => string;
  };

describe("daytona exec launcher", () => {
  it("decodes the payload file and removes the payload directory", async () => {
    const launcher = await loadLauncher();
    const payloadDir = mkdtempSync(path.join(tmpdir(), "daytona-launcher-test-"));
    const payloadFile = path.join(payloadDir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify({ sandboxId: "sbx-1", usePty: false }));

    const payload = launcher.decodePayload(["--payload-file", payloadFile]);

    expect(payload).toEqual({ sandboxId: "sbx-1", usePty: false });
    expect(existsSync(payloadDir)).toBe(false);
  });

  it("rejects missing payload arguments", async () => {
    const launcher = await loadLauncher();
    expect(() => launcher.decodePayload([])).toThrow("Missing --payload-file");
    expect(() => launcher.decodePayload(["--payload-file"])).toThrow(
      "Missing --payload-file value",
    );
  });

  it("escapes shell words for the PTY exec wrapper", async () => {
    const launcher = await loadLauncher();
    expect(launcher.shellEscape("plain")).toBe("'plain'");
    expect(launcher.shellEscape("with 'quote'")).toBe(`'with '"'"'quote'"'"''`);
  });
});
