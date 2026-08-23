import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));
const transcriptMocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  failAfter: undefined as number | undefined,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    withSessionTranscriptWriteLock: async (
      _params: unknown,
      run: (context: {
        appendMessage: (params: {
          message: Record<string, unknown>;
          idempotencyLookup?: string;
        }) => Promise<void>;
      }) => Promise<void>,
    ) => {
      const pending: Array<Record<string, unknown>> = [];
      await run({
        appendMessage: async ({ message, idempotencyLookup }) => {
          if (transcriptMocks.failAfter === pending.length + 1) {
            throw new Error("transcript append failed");
          }
          const key = message.idempotencyKey;
          if (
            idempotencyLookup === "scan" &&
            typeof key === "string" &&
            [...transcriptMocks.messages, ...pending].some(
              (candidate) => candidate.idempotencyKey === key,
            )
          ) {
            return;
          }
          pending.push(message);
        },
      });
      transcriptMocks.messages.push(...pending);
    },
  };
});

import {
  capturePiContinuationCatalog,
  createPiStoreFixture,
  installFakePiFixture,
} from "./pi-session-catalog.test-support.js";

const temporaryDirectories: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;

afterEach(async () => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  process.env.PATH = originalPath;
  transcriptMocks.messages.length = 0;
  transcriptMocks.failAfter = undefined;
  if (originalSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Pi session catalog continuation", () => {
  it("adopts once with the native ACP binding and an exact file baseline", async () => {
    const sessionDirectory = await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    await installFakePiFixture(temporaryDirectories, originalPath);
    const { createSessionEntry, provider } = capturePiContinuationCatalog();

    const [first, concurrent] = await Promise.all([
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ]);
    const second = await provider.continueSession!({ hostId: "gateway", threadId: "pi-session" });
    const sessionFile = await fs.realpath(path.join(sessionDirectory, "session.jsonl"));
    const sessionStats = await fs.stat(sessionFile);

    expect(first).toEqual(concurrent);
    expect(second).toEqual(first);
    expect(first.upstream).toEqual({
      kind: "pi-cli",
      ref: { filePath: sessionFile },
      marker: expect.objectContaining({ offset: sessionStats.size }),
    });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Pi catalog session",
        spawnedCwd: "/workspace",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-session" },
          pluginExtensions: { acpx: { piSessionCatalog: { sourceThreadId: "pi-session" } } },
        },
      }),
    );
    expect(
      transcriptMocks.messages.map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual([
      "hello",
      "Thinking\n\nthinking",
      "hi",
      'Tool call\n\nbash\n{"command":"pwd"}',
      "Tool result\n\nbash\n/workspace",
    ]);
    expect(transcriptMocks.messages[0]?.["__openclaw"]).toEqual({
      mirrorOrigin: "pi-catalog-import",
    });

    const createParams = createSessionEntry.mock.calls[0]?.[0];
    const adopted = createSessionEntry.mock.results[0]?.value;
    await createParams?.afterCreate?.(await adopted);
    expect(transcriptMocks.messages).toHaveLength(5);
  });

  it("rolls adoption back when transcript import fails", async () => {
    await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    await installFakePiFixture(temporaryDirectories, originalPath);
    transcriptMocks.failAfter = 2;
    const { entries, provider } = capturePiContinuationCatalog();

    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("transcript append failed");
    expect(entries).toEqual([]);
    expect(transcriptMocks.messages).toEqual([]);
  });

  it("rejects paired-node and unknown session continuation", async () => {
    await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    await installFakePiFixture(temporaryDirectories, originalPath);
    const { createSessionEntry, provider } = capturePiContinuationCatalog();

    await expect(
      provider.continueSession!({ hostId: "node:remote", threadId: "pi-session" }),
    ).rejects.toThrow("paired-node Pi session rows are view-only");
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "missing" }),
    ).rejects.toThrow("Pi session is unavailable");
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("keeps legacy-session adoption successful when a safe baseline is unavailable", async () => {
    const sessionDirectory = await createPiStoreFixture(
      temporaryDirectories,
      "hi",
      "Pi catalog session",
      { command: "pwd" },
      true,
    );
    const sessionFile = path.join(sessionDirectory, "session.jsonl");
    const content = await fs.readFile(sessionFile, "utf8");
    await fs.writeFile(sessionFile, content.replace('"version":3', '"version":2'));
    await installFakePiFixture(temporaryDirectories, originalPath);
    const { createSessionEntry, provider } = capturePiContinuationCatalog();

    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).resolves.toEqual({ sessionKey: expect.any(String) });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
  });
});
