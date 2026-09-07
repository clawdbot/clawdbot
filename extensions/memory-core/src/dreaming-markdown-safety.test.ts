// Regression tests for managed dreaming Markdown filesystem safety.
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const MEMORY_DREAMING_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
const { createTempWorkspace } = createMemoryCoreTestHarness();
const LIGHT_START_MARKER = "<!-- openclaw:dreaming:light:start -->";
const LIGHT_END_MARKER = "<!-- openclaw:dreaming:light:end -->";
const LIGHT_HEADING = "## Light Sleep";
const INPUT_CHUNK_CHARS = 65_536;
const UNICODE_TAIL = "🦞";

afterEach(() => {
  vi.restoreAllMocks();
});

async function createOversizedStreamSource(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "source", "utf-8");
  await fs.truncate(filePath, MEMORY_DREAMING_MARKDOWN_MAX_BYTES + 1);
}

async function withControlledInputChunks<T>(
  filePath: string,
  chunks: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const originalOpen = fs.open;
  const canonicalFilePath = await fs.realpath(filePath);
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openPath, ...rest) => {
    const handle = await originalOpen(openPath, ...rest);
    if (String(openPath) !== canonicalFilePath) {
      return handle;
    }
    return new Proxy(handle as FileHandle, {
      get(target, property) {
        if (property === "createReadStream") {
          return () => Readable.from(chunks);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });

  try {
    return await operation();
  } finally {
    openSpy.mockRestore();
  }
}

function describeStringDifference(label: string, received: string, expected: string): string {
  let index = 0;
  while (
    index < received.length &&
    index < expected.length &&
    received[index] === expected[index]
  ) {
    index += 1;
  }
  const context = (value: string) => JSON.stringify(value.slice(Math.max(0, index - 8), index + 8));
  return `${label} differs at code unit ${index} (length ${received.length} != ${expected.length}): received ${context(
    received,
  )}, expected ${context(expected)}`;
}

describe("dreaming markdown filesystem safety", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("completes oversized streaming replacements after short writes", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: short-write update";
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      startMarker,
      "- Old candidate",
      endMarker,
      "Tail stays.",
    ].join("\n");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(inlinePath, original, "utf-8");

    let shortWriteCount = 0;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openPath, ...rest) => {
      const handle = await originalOpen(openPath, ...rest);
      const rawWrite = handle.write.bind(handle) as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let injected = false;
      handle.write = (async (...args: unknown[]) => {
        const [data, offset, length, position] = args;
        if (
          !injected &&
          Buffer.isBuffer(data) &&
          typeof offset === "number" &&
          typeof length === "number" &&
          typeof position === "number" &&
          length > 1
        ) {
          injected = true;
          shortWriteCount += 1;
          const partialArgs = [...args];
          partialArgs[2] = Math.max(1, Math.floor(length / 2));
          return await rawWrite(...partialArgs);
        }
        return await rawWrite(...args);
      }) as typeof handle.write;
      return handle;
    });

    try {
      await writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: [body],
        nowMs,
        timezone,
        storage: { mode: "inline", separateReports: false },
      });

      expect(shortWriteCount).toBeGreaterThan(0);
      await expect(fs.readFile(inlinePath, "utf-8")).resolves.toBe(
        withTrailingNewline(
          replaceManagedMarkdownBlock({
            original,
            heading: "## Light Sleep",
            startMarker,
            endMarker,
            body,
          }),
        ),
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("preserves a surrogate pair at the oversized rolling-window cut", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-unicode-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const body = "- Candidate: Unicode stays exact";
    const rollingWindowBytes =
      Math.max(LIGHT_HEADING.length + LIGHT_START_MARKER.length, LIGHT_END_MARKER.length) + 4096;
    const keep = INPUT_CHUNK_CHARS - rollingWindowBytes;
    const prefixLength = keep - 1;
    const firstChunk = `${"A".repeat(prefixLength)}${UNICODE_TAIL}${"B".repeat(
      INPUT_CHUNK_CHARS - prefixLength - UNICODE_TAIL.length,
    )}`;
    const secondChunk = [
      "",
      LIGHT_HEADING,
      LIGHT_START_MARKER,
      "- Old candidate",
      LIGHT_END_MARKER,
      "Tail stays.",
    ].join("\n");
    const original = firstChunk + secondChunk;
    await createOversizedStreamSource(inlinePath);

    await withControlledInputChunks(inlinePath, [firstChunk, secondChunk], () =>
      writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: [body],
        nowMs,
        timezone,
        storage: { mode: "inline", separateReports: false },
      }),
    );

    const content = await fs.readFile(inlinePath, "utf-8");
    const expected = withTrailingNewline(
      replaceManagedMarkdownBlock({
        original,
        heading: LIGHT_HEADING,
        startMarker: LIGHT_START_MARKER,
        endMarker: LIGHT_END_MARKER,
        body,
      }),
    );
    expect(
      content === expected,
      describeStringDifference("rolling-window replacement", content, expected),
    ).toBe(true);
    expect(content).toContain(UNICODE_TAIL);
    expect(content).not.toContain("\uFFFD");
  });

  it("preserves a surrogate pair while spooling an unterminated block", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-unicode-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const body = "- Candidate: replayed Unicode stays exact";
    const skipKeep = 60_000;
    const skippedLength = skipKeep + LIGHT_END_MARKER.length - 1;
    const skippedPrefixLength = skipKeep - 1;
    const skipped = `${"A".repeat(skippedPrefixLength)}${UNICODE_TAIL}${"B".repeat(
      skippedLength - skippedPrefixLength - UNICODE_TAIL.length,
    )}`;
    const firstChunk = `${LIGHT_HEADING}\n${LIGHT_START_MARKER}${skipped}`;
    const secondChunk = "Tail stays.";
    const original = firstChunk + secondChunk;
    await createOversizedStreamSource(inlinePath);

    await withControlledInputChunks(inlinePath, [firstChunk, secondChunk], () =>
      writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: [body],
        nowMs,
        timezone,
        storage: { mode: "inline", separateReports: false },
      }),
    );

    const content = await fs.readFile(inlinePath, "utf-8");
    const managedBlock = `${LIGHT_HEADING}\n${LIGHT_START_MARKER}\n${body}\n${LIGHT_END_MARKER}`;
    const expected = `${original}\n\n${managedBlock}\n`;
    expect(
      content === expected,
      describeStringDifference("unterminated-block replay", content, expected),
    ).toBe(true);
    expect(content).toContain(UNICODE_TAIL);
    expect(content).not.toContain("\uFFFD");
  });
  it("rejects daily memory symlinks under an external memory parent", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const memoryDir = path.join(workspaceDir, "memory");
    const externalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-external-memory`,
    );
    const externalPath = path.join(externalMemoryDir, "targets", "2026-04-05.md");
    await fs.mkdir(externalMemoryDir, { recursive: true });
    await fs.symlink(externalMemoryDir, memoryDir);

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Must not write through an external memory parent"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow("outside workspace memory directory");
      await expect(fs.access(externalPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(memoryDir, { force: true });
      await fs.rm(externalMemoryDir, { force: true, recursive: true });
    }
  });

  it("rejects a parent-directory swap before an oversized final commit", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-race-");
    const memoryDir = path.join(workspaceDir, "memory");
    const originalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-memory-original`,
    );
    const externalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-external-memory`,
    );
    const inlinePath = path.join(memoryDir, "2026-04-05.md");
    const externalPath = path.join(externalMemoryDir, "2026-04-05.md");
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- Old candidate",
      "<!-- openclaw:dreaming:light:end -->",
      "Tail stays.",
    ].join("\n");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(externalMemoryDir, { recursive: true });
    await fs.writeFile(inlinePath, original, "utf-8");
    await fs.writeFile(externalPath, original, "utf-8");

    let swapTriggered = false;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openPath, ...rest) => {
      const handle = await originalOpen(openPath, ...rest);
      if (
        !swapTriggered &&
        typeof openPath === "string" &&
        openPath !== inlinePath &&
        path.basename(openPath) === path.basename(inlinePath)
      ) {
        const rawSync = handle.sync.bind(handle) as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>;
        handle.sync = (async (...args: unknown[]) => {
          if (!swapTriggered) {
            swapTriggered = true;
            await fs.rename(memoryDir, originalMemoryDir);
            await fs.symlink(externalMemoryDir, memoryDir);
          }
          return await rawSync(...args);
        }) as typeof handle.sync;
      }
      return handle;
    });

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: parent swap must not redirect the commit"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow();
      expect(swapTriggered).toBe(true);
      await expect(fs.readFile(externalPath, "utf-8")).resolves.toBe(original);
    } finally {
      openSpy.mockRestore();
      if (swapTriggered) {
        await fs.rm(memoryDir, { force: true, recursive: true });
        await fs.rename(originalMemoryDir, memoryDir);
      }
      await fs.rm(externalMemoryDir, { force: true, recursive: true });
    }

    await expect(fs.readFile(inlinePath, "utf-8")).resolves.toBe(original);
  });

  it("surfaces oversized streaming temporary-directory cleanup failures", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-cleanup-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Old candidate",
        "<!-- openclaw:dreaming:light:end -->",
      ].join("\n"),
      "utf-8",
    );

    const realRm = fs.rm;
    let tempDir: string | undefined;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (typeof target === "string" && options?.recursive === true) {
        tempDir = target;
        throw new Error("streaming temp cleanup failed");
      }
      return await realRm(target, options);
    });

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: cleanup failure is visible"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow("streaming temp cleanup failed");
      expect(tempDir).toBeDefined();
    } finally {
      rmSpy.mockRestore();
      if (tempDir) {
        await realRm(tempDir, { force: true, recursive: true });
      }
    }
  });
});
