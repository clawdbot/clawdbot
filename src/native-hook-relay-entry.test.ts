import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  parseNativeHookRelayEntryArgs,
  runNativeHookRelayEntry,
  type FastRelayOptions,
} from "./native-hook-relay-entry.js";

function options(overrides: Partial<FastRelayOptions> = {}): FastRelayOptions {
  return {
    provider: "codex",
    relayId: "relay-1",
    stateDb: "/tmp/openclaw.sqlite",
    stateSchemaVersion: 5,
    generation: "generation-1",
    event: "pre_tool_use",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function readable(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

function writable(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}

const record = {
  relayId: "relay-1",
  pid: 42,
  hostname: "127.0.0.1" as const,
  port: 19_999,
  token: "opaque-token",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

describe("native hook relay minimal entry", () => {
  it("parses the generated command contract without importing the full CLI", () => {
    expect(
      parseNativeHookRelayEntryArgs([
        "--provider",
        "codex",
        "--relay-id",
        "relay-1",
        "--state-db",
        "/tmp/openclaw.sqlite",
        "--state-schema-version",
        "5",
        "--generation",
        "generation-1",
        "--event",
        "post_tool_use",
        "--timeout",
        "4321",
      ]),
    ).toEqual(options({ event: "post_tool_use", timeoutMs: 4_321 }));
  });

  it("forwards JSON to the bridge and preserves its response byte-for-byte", async () => {
    const stdout = writable();
    const stderr = writable();
    const post = vi.fn(async (_params: { body: string }) => ({
      stdout: "exact-out\n",
      stderr: "exact-err\n",
      exitCode: 7,
    }));
    const fallback = vi.fn();

    await expect(
      runNativeHookRelayEntry(options(), {
        stdin: readable('{"tool_name":"Bash"}'),
        stdout,
        stderr,
        readRecord: () => record,
        post,
        fallback,
      }),
    ).resolves.toBe(7);

    expect(stdout.text()).toBe("exact-out\n");
    expect(stderr.text()).toBe("exact-err\n");
    expect(JSON.parse(post.mock.calls[0]?.[0].body as string)).toEqual({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: { tool_name: "Bash" },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("reads the real SQLite locator and invokes a loopback bridge end to end", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-native-hook-entry-"));
    const stateDb = path.join(tempDir, "state.sqlite");
    const token = "integration-token";
    let receivedAuthorization = "";
    let receivedBody = "";
    const server = createServer((request, response) => {
      receivedAuthorization = String(request.headers.authorization ?? "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        const body = JSON.stringify({
          ok: true,
          result: { stdout: "integrated\n", stderr: "", exitCode: 0 },
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test bridge did not expose a TCP port");
    }
    const db = new DatabaseSync(stateDb);
    try {
      db.exec(`
        PRAGMA user_version = 5;
        CREATE TABLE native_hook_relay_bridges (
          relay_id TEXT NOT NULL PRIMARY KEY,
          pid INTEGER NOT NULL,
          hostname TEXT NOT NULL,
          port INTEGER NOT NULL,
          token TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
      `);
      db.prepare(
        `INSERT INTO native_hook_relay_bridges
          (relay_id, pid, hostname, port, token, expires_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "relay-1",
        process.pid,
        "127.0.0.1",
        address.port,
        token,
        Date.now() + 60_000,
        Date.now(),
      );
    } finally {
      db.close();
    }

    const stdout = writable();
    try {
      await expect(
        runNativeHookRelayEntry(options({ stateDb }), {
          stdin: readable('{"tool_name":"Bash"}'),
          stdout,
        }),
      ).resolves.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(tempDir, { force: true, recursive: true });
    }

    expect(stdout.text()).toBe("integrated\n");
    expect(receivedAuthorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(receivedBody)).toMatchObject({
      relayId: "relay-1",
      event: "pre_tool_use",
      rawPayload: { tool_name: "Bash" },
    });
  });

  it("renders overload locally and never bypasses admission through fallback", async () => {
    const stdout = writable();
    const stderr = writable();
    const fallback = vi.fn();

    await expect(
      runNativeHookRelayEntry(options({ event: "permission_request" }), {
        stdin: readable("{}"),
        stdout,
        stderr,
        readRecord: () => record,
        post: async () => {
          throw Object.assign(new Error("native hook relay overloaded"), {
            code: "overloaded",
          });
        },
        fallback,
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.text())).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Native hook relay overloaded" },
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("re-reads the locator during replacement and accepts the successor", async () => {
    let now = 0;
    const post = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "stale" }))
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const fallback = vi.fn();

    await expect(
      runNativeHookRelayEntry(options(), {
        stdin: readable("{}"),
        readRecord: () => record,
        post,
        fallback,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).resolves.toBe(0);

    expect(post).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    ["missing locator", Object.assign(new Error("missing"), { code: "ENOENT" })],
    ["refused bridge", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })],
    ["unsafe database", new Error("unsupported OpenClaw state database schema")],
  ])("uses the full same-process fallback for %s", async (_label, failure) => {
    let now = 0;
    const fallback = vi.fn(async () => 9);

    await expect(
      runNativeHookRelayEntry(options(), {
        stdin: readable('{"x":1}'),
        readRecord: () => {
          throw failure;
        },
        fallback,
        now: () => now,
        sleep: async () => {
          now += 100;
        },
      }),
    ).resolves.toBe(9);

    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ relayId: "relay-1" }),
      '{"x":1}',
      expect.any(Object),
      expect.any(Number),
    );
  });

  it("falls back instead of contacting an expired bridge record", async () => {
    const post = vi.fn();
    const fallback = vi.fn(async () => 8);

    await expect(
      runNativeHookRelayEntry(options(), {
        stdin: readable("{}"),
        readRecord: () => ({ ...record, expiresAtMs: 999 }),
        post,
        fallback,
        now: () => 1_000,
      }),
    ).resolves.toBe(8);

    expect(post).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("rejects oversized input before locator access or fallback", async () => {
    const stderr = writable();
    const readRecord = vi.fn();
    const fallback = vi.fn();

    await expect(
      runNativeHookRelayEntry(options({ event: "post_tool_use" }), {
        stdin: readable("x".repeat(1024 * 1024 + 1)),
        stderr,
        readRecord,
        fallback,
      }),
    ).resolves.toBe(1);

    expect(stderr.text()).toContain("native hook input exceeds");
    expect(readRecord).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("bounds held-open stdin and returns the event-specific timeout response", async () => {
    const stdin = new PassThrough();
    stdin.write("{}");
    const stdout = writable();
    const stderr = writable();

    await expect(
      runNativeHookRelayEntry(options({ timeoutMs: 20 }), {
        stdin,
        stdout,
        stderr,
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.text())).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay timed out",
      },
    });
    expect(stderr.text()).toContain("native hook relay timed out");
    expect(stdin.destroyed).toBe(true);
  });
});
