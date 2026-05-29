import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInfiniteSessionConfig, writeOpenClawCompactionMarker } from "./compaction-bridge.js";

describe("createInfiniteSessionConfig", () => {
  it("returns undefined when no options provided", () => {
    expect(createInfiniteSessionConfig()).toBeUndefined();
    expect(createInfiniteSessionConfig(undefined)).toBeUndefined();
  });

  it("returns undefined when options is an empty object", () => {
    expect(createInfiniteSessionConfig({})).toBeUndefined();
  });

  it("preserves explicit enabled:false to disable infinite sessions", () => {
    expect(createInfiniteSessionConfig({ enabled: false })).toEqual({ enabled: false });
  });

  it("preserves explicit enabled:true", () => {
    expect(createInfiniteSessionConfig({ enabled: true })).toEqual({ enabled: true });
  });

  it("forwards threshold fields when set", () => {
    expect(
      createInfiniteSessionConfig({
        backgroundCompactionThreshold: 0.7,
        bufferExhaustionThreshold: 0.9,
      }),
    ).toEqual({
      backgroundCompactionThreshold: 0.7,
      bufferExhaustionThreshold: 0.9,
    });
  });

  it("combines enabled and thresholds", () => {
    expect(
      createInfiniteSessionConfig({
        enabled: true,
        backgroundCompactionThreshold: 0.5,
        bufferExhaustionThreshold: 0.85,
      }),
    ).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.5,
      bufferExhaustionThreshold: 0.85,
    });
  });

  it("omits undefined fields without coercing them", () => {
    const result = createInfiniteSessionConfig({
      enabled: undefined,
      backgroundCompactionThreshold: 0.6,
      bufferExhaustionThreshold: undefined,
    });
    expect(result).toEqual({ backgroundCompactionThreshold: 0.6 });
    expect(result).not.toHaveProperty("enabled");
    expect(result).not.toHaveProperty("bufferExhaustionThreshold");
  });
});

describe("writeOpenClawCompactionMarker", () => {
  it("writes a JSON marker with expected shape under <workspaceDir>/files", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "copilot-compaction-"));
    try {
      const written = await writeOpenClawCompactionMarker(
        {
          sessionId: "openclaw-sess-123",
          workspaceDir,
          trigger: "manual",
          currentTokenCount: 42,
          sdkSessionId: "sdk-sess-abc",
          reason: "deferred-to-sdk-infinite-sessions",
        },
        { now: () => 1_700_000_000_000 },
      );

      expect(written.path).toBe(
        join(workspaceDir, "files", "openclaw-compaction-1700000000000-openclaw-sess-123.json"),
      );
      expect(written.marker).toEqual({
        version: 1,
        source: "copilot-harness",
        sessionId: "openclaw-sess-123",
        ts: 1_700_000_000_000,
        compacted: false,
        trigger: "manual",
        sdkSessionId: "sdk-sess-abc",
        currentTokenCount: 42,
        reason: "deferred-to-sdk-infinite-sessions",
      });

      const contents = await readFile(written.path, "utf8");
      expect(contents.endsWith("\n")).toBe(true);
      expect(JSON.parse(contents)).toEqual(written.marker);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records force:true in the marker without acting on it", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const fs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, contents: string) => {
        writes.push({ path, contents });
      }),
    };

    const written = await writeOpenClawCompactionMarker(
      {
        sessionId: "s1",
        workspaceDir: "/ws",
        force: true,
        reason: "force-requested-but-sdk-has-no-synchronous-compact-api",
      },
      { now: () => 1, fs: fs as never },
    );

    expect(written.marker.force).toBe(true);
    expect(written.marker.compacted).toBe(false);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].contents)).toMatchObject({ force: true });
  });

  it("omits force / trigger / sdkSessionId / currentTokenCount when undefined", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    const fs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, contents: string) => {
        writes.push({ path, contents });
      }),
    };

    const written = await writeOpenClawCompactionMarker(
      { sessionId: "s1", workspaceDir: "/ws" },
      { now: () => 7, fs: fs as never },
    );

    expect(written.marker).toEqual({
      version: 1,
      source: "copilot-harness",
      sessionId: "s1",
      ts: 7,
      compacted: false,
    });
    const parsed = JSON.parse(writes[0].contents);
    expect(parsed).not.toHaveProperty("force");
    expect(parsed).not.toHaveProperty("trigger");
    expect(parsed).not.toHaveProperty("sdkSessionId");
    expect(parsed).not.toHaveProperty("currentTokenCount");
    expect(parsed).not.toHaveProperty("reason");
  });

  it("sanitizes sessionId chars in the filename", async () => {
    const fs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    };
    const written = await writeOpenClawCompactionMarker(
      { sessionId: "abc:/?\\@!def", workspaceDir: "/ws" },
      { now: () => 1, fs: fs as never },
    );
    expect(written.path).toContain("openclaw-compaction-1-abc______def.json");
    // sessionId in the marker body stays the original unsanitized value.
    expect(written.marker.sessionId).toBe("abc:/?\\@!def");
  });

  it("creates the subdir recursively before writing", async () => {
    const calls: Array<{ kind: "mkdir" | "write"; path: string; opts?: unknown }> = [];
    const fs = {
      mkdir: vi.fn(async (path: string, opts: unknown) => {
        calls.push({ kind: "mkdir", path, opts });
      }),
      writeFile: vi.fn(async (path: string) => {
        calls.push({ kind: "write", path });
      }),
    };
    await writeOpenClawCompactionMarker(
      { sessionId: "s", workspaceDir: "/ws" },
      { now: () => 1, fs: fs as never },
    );
    expect(calls[0]).toEqual({ kind: "mkdir", path: "/ws/files", opts: { recursive: true } });
    expect(calls[1]?.kind).toBe("write");
  });

  it("honours a custom subdir option", async () => {
    const fs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    };
    const written = await writeOpenClawCompactionMarker(
      { sessionId: "s", workspaceDir: "/ws" },
      { now: () => 1, fs: fs as never, subdir: "compaction" },
    );
    expect(written.path).toBe("/ws/compaction/openclaw-compaction-1-s.json");
  });

  it("surfaces mkdir failures", async () => {
    const fs = {
      mkdir: vi.fn(async () => {
        throw new Error("EACCES");
      }),
      writeFile: vi.fn(async () => undefined),
    };
    await expect(
      writeOpenClawCompactionMarker(
        { sessionId: "s", workspaceDir: "/ws" },
        { now: () => 1, fs: fs as never },
      ),
    ).rejects.toThrow("EACCES");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("surfaces writeFile failures", async () => {
    const fs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => {
        throw new Error("ENOSPC");
      }),
    };
    await expect(
      writeOpenClawCompactionMarker(
        { sessionId: "s", workspaceDir: "/ws" },
        { now: () => 1, fs: fs as never },
      ),
    ).rejects.toThrow("ENOSPC");
  });

  it("throws on missing sessionId", async () => {
    await expect(
      writeOpenClawCompactionMarker({ sessionId: "", workspaceDir: "/ws" }),
    ).rejects.toThrow(/sessionId is required/);
  });

  it("throws on missing workspaceDir", async () => {
    await expect(
      writeOpenClawCompactionMarker({ sessionId: "s", workspaceDir: "" }),
    ).rejects.toThrow(/workspaceDir is required/);
  });
});
