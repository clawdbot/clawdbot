// Check Memory Fd Repro tests cover check memory fd repro script behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_READY_OUTPUT_MAX_CHARS,
  MEMORY_SEARCH_PROBE_QUERY,
  MEMORY_SEARCH_RESPONSE_MAX_BYTES,
  classifyMemorySearchInvokeResponse,
  hasChildExited,
  invokeMemorySearch,
  parseArgs,
  readBoundedResponseText,
  readNumber,
  readPositiveNumber,
  stopGatewayWithRuntime,
  updateGatewayReadyOutputState,
  waitForGatewayReady,
  writeConfig,
} from "../../scripts/check-memory-fd-repro.mjs";
import { withEnv } from "../../src/test-utils/env.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

describe("check-memory-fd-repro", () => {
  it("parses file, fd, and timing limits as strict integers", () => {
    expect(readNumber("0", "limit")).toBe(0);
    expect(readNumber(" 42 ", "limit")).toBe(42);
    expect(readPositiveNumber("1", "limit")).toBe(1);

    expect(() => readNumber("1.5", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readNumber("1e3", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readNumber("10files", "limit")).toThrow("limit must be a non-negative integer");
    expect(() => readPositiveNumber("0", "limit")).toThrow("limit must be greater than 0");
  });

  it("rejects loose numeric environment limits before generating files", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "0",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "0",
          OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
          OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        },
        () => parseArgs([]),
      ),
    ).toMatchObject({
      fileCount: 17,
      invokeTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      maxWorkspaceRegFds: 0,
      sampleDelayMs: 0,
      settleDelayMs: MAX_TIMER_TIMEOUT_MS,
    });

    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_FILES: "17files" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_FILES must be a non-negative integer");
    expect(() =>
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3" }, () => parseArgs([])),
    ).toThrow("OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS must be a non-negative integer");
  });

  it("lets explicit CLI numeric flags override malformed inherited env defaults", () => {
    expect(
      withEnv(
        {
          OPENCLAW_MEMORY_FD_REPRO_FILES: "17files",
          OPENCLAW_MEMORY_FD_REPRO_MAX_WORKSPACE_REG_FDS: "4fds",
          OPENCLAW_MEMORY_FD_REPRO_TIMEOUT_MS: "1e3",
          OPENCLAW_MEMORY_FD_REPRO_SAMPLE_DELAY_MS: "soon",
          OPENCLAW_MEMORY_FD_REPRO_SETTLE_DELAY_MS: "later",
        },
        () =>
          parseArgs([
            "--files",
            "20",
            "--max-workspace-reg-fds",
            "4",
            "--invoke-timeout-ms",
            "1000",
            "--sample-delay-ms",
            "0",
            "--settle-delay-ms",
            "0",
          ]),
      ),
    ).toMatchObject({
      fileCount: 20,
      invokeTimeoutMs: 1000,
      maxWorkspaceRegFds: 4,
      sampleDelayMs: 0,
      settleDelayMs: 0,
    });
  });

  it("rejects missing valued options instead of consuming the next flag", () => {
    for (const flag of [
      "--files",
      "--invoke-timeout-ms",
      "--max-workspace-reg-fds",
      "--min-leaked-fds",
      "--mode",
      "--output-dir",
      "--sample-delay-ms",
      "--settle-delay-ms",
    ]) {
      for (const value of ["--keep", "-h"]) {
        expect(() => parseArgs([flag, value])).toThrow(`Missing value for ${flag}`);
      }
    }
  });

  it("stops parsing options after the argument terminator", () => {
    expect(parseArgs(["--files", "20", "--", "--files", "99"])).toMatchObject({
      fileCount: 20,
    });

    expect(
      withEnv({ OPENCLAW_MEMORY_FD_REPRO_FILES: "17" }, () => parseArgs(["--", "--unknown"])),
    ).toMatchObject({
      fileCount: 17,
    });
  });

  it("accepts the leading package-manager argument separator", () => {
    expect(parseArgs(["--", "--files", "20", "--allow-non-darwin"])).toMatchObject({
      allowNonDarwin: true,
      fileCount: 20,
    });
  });

  it("clamps oversized memory_search invoke timers before scheduling", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            result: {
              content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
            },
          }),
        );
      }, 25);
    });
    const port = await listen(server);
    try {
      await expect(
        invokeMemorySearch({
          port,
          token: "test-token",
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        }),
      ).resolves.toMatchObject({
        gatewayOk: true,
        ok: true,
        resultCount: 0,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("uses a fast matching probe query instead of a no-hit stress query", () => {
    expect(MEMORY_SEARCH_PROBE_QUERY).toBe("Top-level memory file");
    expect(MEMORY_SEARCH_PROBE_QUERY).not.toContain("nomatch");
  });

  it("writes an offline FTS-only memory search config for repro indexing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-fd-config-"));
    try {
      const homeDir = path.join(root, "home");
      const workspaceDir = path.join(root, "workspace");
      const configPath = writeConfig({
        homeDir,
        workspaceDir,
        port: 12345,
        token: "test-token",
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const memorySearch = config.memory.search;

      expect(memorySearch.store).toEqual({ vector: { enabled: false } });
      expect(memorySearch).toMatchObject({
        provider: "none",
        model: "",
        sync: {
          onSearch: false,
          onSessionStart: false,
          watch: true,
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an available memory_search tool payload", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        result: {
          content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      gatewayOk: true,
      resultCount: 0,
    });
  });

  it("rejects disabled memory_search tool payloads", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [],
                disabled: true,
                unavailable: true,
                error: 'No API key found for provider "openai".',
              }),
            },
          ],
        },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      gatewayOk: true,
      toolDisabled: true,
      toolUnavailable: true,
      toolError: 'No API key found for provider "openai".',
    });
  });

  it("rejects gateway success envelopes without memory_search details", () => {
    const result = classifyMemorySearchInvokeResponse({
      httpOk: true,
      status: 200,
      bodyText: JSON.stringify({ ok: true, result: { content: [] } }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: "memory_search result payload missing or invalid",
    });
  });

  it("treats signaled gateway children as exited", () => {
    expect(hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("fails gateway readiness immediately after signal exits", async () => {
    const child = {
      exitCode: null,
      signalCode: "SIGTERM",
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    };

    await expect(
      waitForGatewayReady({ child, port: 9, logPath: "gateway.log", timeoutMs: 10_000 }),
    ).rejects.toThrow("gateway exited before ready");
  });

  it("does not signal already exited children during gateway cleanup", async () => {
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: "SIGTERM",
    };
    const findGatewayPidFn = vi.fn(() => null);
    const killProcess = vi.fn();

    await expect(
      stopGatewayWithRuntime({ child, findGatewayPidFn, killProcess, port: 9 }),
    ).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(findGatewayPidFn).toHaveBeenCalledWith(9);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("force-kills a gateway child that survives listener cleanup", async () => {
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    };
    const findGatewayPidFn = vi.fn().mockReturnValueOnce(1234).mockReturnValue(null);
    const killProcess = vi.fn();

    await expect(
      stopGatewayWithRuntime({
        child,
        childExitPolls: 0,
        findGatewayPidFn,
        killProcess,
        listenerSettleDelayMs: 0,
        port: 9,
      }),
    ).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGINT");
    expect(killProcess).toHaveBeenCalledWith(1234, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("bounds gateway readiness output while keeping newest logs", () => {
    const first = updateGatewayReadyOutputState({ tail: "abc", readySeen: false }, "def", 8);
    expect(first).toEqual({ tail: "abcdef", readySeen: false });

    const second = updateGatewayReadyOutputState(first, "ghijkl", 8);
    expect(second).toEqual({ tail: "efghijkl", readySeen: false });
    expect(second.tail).toHaveLength(8);
    expect(GATEWAY_READY_OUTPUT_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps readiness after a coalesced noisy chunk truncates the marker", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "", readySeen: false },
      `[gateway] ready\n${"x".repeat(10_000)}`,
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toHaveLength(64);
    expect(state.tail).not.toContain("[gateway] ready");
  });

  it("recognizes readiness split across the existing tail and new chunk", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "[gateway] rea", readySeen: false },
      "dy\n",
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("[gateway] ready\n");
  });

  it("preserves previous readiness once seen", () => {
    const state = updateGatewayReadyOutputState({ tail: "old", readySeen: true }, "new output", 8);

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("w output");
  });

  it("reads memory_search response bodies under the byte cap", async () => {
    await expect(
      readBoundedResponseText(
        new Response("ok"),
        "memory_search",
        MEMORY_SEARCH_RESPONSE_MAX_BYTES,
      ),
    ).resolves.toBe("ok");
  });

  it("rejects oversized memory_search response bodies from content-length", async () => {
    const response = new Response("ignored", {
      headers: { "content-length": String(MEMORY_SEARCH_RESPONSE_MAX_BYTES + 1) },
    });

    await expect(
      readBoundedResponseText(response, "memory_search", MEMORY_SEARCH_RESPONSE_MAX_BYTES),
    ).rejects.toThrow(
      `memory_search response body exceeded ${MEMORY_SEARCH_RESPONSE_MAX_BYTES} bytes`,
    );
  });

  it("stops reading memory_search response streams after the byte cap", async () => {
    const chunk = new Uint8Array(MEMORY_SEARCH_RESPONSE_MAX_BYTES + 1);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    );

    await expect(
      readBoundedResponseText(response, "memory_search", MEMORY_SEARCH_RESPONSE_MAX_BYTES),
    ).rejects.toThrow(
      `memory_search response body exceeded ${MEMORY_SEARCH_RESPONSE_MAX_BYTES} bytes`,
    );
  });
});
