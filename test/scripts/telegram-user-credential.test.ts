import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchJsonWithTimeout, runCommand } from "../../scripts/e2e/telegram-user-credential-io.ts";
import {
  expandHome,
  resolvePrivateJsonDirectory,
  writePrivateJson,
} from "../../scripts/e2e/telegram-user-credential-paths.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("telegram user credential path handling", () => {
  it("expands home paths with the host path implementation", () => {
    expect(
      expandHome("~/payload.json", {
        env: { HOME: "/home/runner" },
        pathImpl: path.posix,
      }),
    ).toBe("/home/runner/payload.json");
    expect(
      expandHome("~/payload.json", {
        env: { USERPROFILE: String.raw`C:\Users\runner` },
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\payload.json`);
  });

  it("resolves native Windows private JSON parent directories", () => {
    expect(
      resolvePrivateJsonDirectory(String.raw`C:\Users\runner\AppData\Local\payload.json`, {
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\AppData\Local`);
  });

  it("resolves relative private JSON output to the current directory", () => {
    expect(resolvePrivateJsonDirectory("payload.json")).toBe(".");
  });

  it("writes private JSON files", async () => {
    const dir = makeTempDir("openclaw-telegram-credential-");
    await writePrivateJson(path.join(dir, "payload.json"), { status: "ok" });
    await expect(readFile(path.join(dir, "payload.json"), "utf8")).resolves.toBe(
      '{\n  "status": "ok"\n}\n',
    );
  });
});

describe("telegram user credential IO", () => {
  it("fails hung child processes instead of waiting for the outer proof timeout", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, {
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringContaining("timed out after 25ms"),
    });
  });

  it.runIf(process.platform !== "win32")(
    "waits for timed-out child processes to exit before rejecting",
    async () => {
      const dir = makeTempDir("openclaw-telegram-credential-timeout-");
      const terminatedPath = path.join(dir, "terminated.txt");
      const scriptPath = path.join(dir, "ignore-term.cjs");
      writeFileSync(
        scriptPath,
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.writeFileSync(process.argv[2], "terminated");
    process.exit(0);
  }, 75);
});
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      const runPromise = runCommand(process.execPath, [scriptPath, terminatedPath], undefined, {
        timeoutKillGraceMs: 1_000,
        timeoutMs: 100,
      });
      const runError = runPromise.catch((error: unknown) => error);

      try {
        const error = (await runError) as Error & { code?: string };
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("ETIMEDOUT");
        expect(error.message).toContain("timed out after 100ms");
        expect(existsSync(terminatedPath)).toBe(true);
      } finally {
        await runPromise.catch(() => {});
      }
    },
  );

  it("aborts broker fetches that never return", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/acquire",
        label: "credential broker acquire",
        timeoutMs: 25,
        init: { method: "POST" },
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "credential broker acquire timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while waiting for broker JSON bodies", async () => {
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/payload-chunk",
        label: "credential broker payload-chunk",
        timeoutMs: 25,
        init: { method: "POST" },
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "credential broker payload-chunk timed out after 25ms",
    });
  });

  it("bounds broker JSON response bodies", async () => {
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/acquire",
        label: "credential broker acquire",
        timeoutMs: 1000,
        maxBodyBytes: 16,
        init: { method: "POST" },
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: "ok", padding: "x".repeat(64) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "credential broker acquire response body exceeded 16 bytes",
    });
  });
});
