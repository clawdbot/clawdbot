import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

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
