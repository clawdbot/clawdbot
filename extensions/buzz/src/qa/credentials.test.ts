import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBuzzQaCredentialPayload, readBuzzQaCredentialFile } from "./credentials.js";

const DRIVER_PRIVATE_KEY = "01".repeat(32);
const SUT_PRIVATE_KEY = "02".repeat(32);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("Buzz QA credentials", () => {
  it("accepts a strict two-identity room payload", () => {
    const credentials = parseBuzzQaCredentialPayload({
      relayUrl: "wss://relay.qa.example",
      roomId: "123e4567-e89b-42d3-a456-426614174000",
      driverPrivateKey: DRIVER_PRIVATE_KEY,
      sutPrivateKey: SUT_PRIVATE_KEY,
      driverAuthTag: '["auth","driver","conditions","signature"]',
      sutAuthTag: '["auth","sut","conditions","signature"]',
    });

    expect(credentials).toMatchObject({
      relayUrl: "wss://relay.qa.example",
      roomId: "123e4567-e89b-42d3-a456-426614174000",
      driverPrivateKey: DRIVER_PRIVATE_KEY,
      sutPrivateKey: SUT_PRIVATE_KEY,
    });
    expect(credentials.driverPublicKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(credentials.sutPublicKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(credentials.driverPublicKey).not.toBe(credentials.sutPublicKey);
  });

  it.each(["ws://localhost:8080", "ws://127.0.0.1:8080", "ws://[::1]:8080"])(
    "allows plaintext loopback relay URL %s",
    (relayUrl) => {
      expect(
        parseBuzzQaCredentialPayload({
          relayUrl,
          roomId: "123e4567-e89b-42d3-a456-426614174000",
          driverPrivateKey: DRIVER_PRIVATE_KEY,
          sutPrivateKey: SUT_PRIVATE_KEY,
        }).relayUrl,
      ).toBe(relayUrl);
    },
  );

  it("rejects plaintext remote relay URLs", () => {
    expect(() =>
      parseBuzzQaCredentialPayload({
        relayUrl: "ws://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: DRIVER_PRIVATE_KEY,
        sutPrivateKey: SUT_PRIVATE_KEY,
      }),
    ).toThrow("Buzz QA credentials are missing or malformed.");
  });

  it("never includes credential values in validation errors", () => {
    const privateKey = "not-a-private-key-value";
    const authTag = "not-an-auth-tag-value";

    expect(() =>
      parseBuzzQaCredentialPayload({
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: privateKey,
        sutPrivateKey: SUT_PRIVATE_KEY,
        driverAuthTag: authTag,
      }),
    ).toThrow("Buzz QA credentials are missing or malformed.");
    try {
      parseBuzzQaCredentialPayload({
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: privateKey,
        sutPrivateKey: SUT_PRIVATE_KEY,
        driverAuthTag: authTag,
      });
    } catch (error) {
      expect(String(error)).not.toContain(privateKey);
      expect(String(error)).not.toContain(authTag);
    }
  });

  it("reads a repo-relative private JSON credential file", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-buzz-qa-"));
    tempDirs.push(repoRoot);
    const filePath = path.join("private", "buzz.json");
    await fs.mkdir(path.join(repoRoot, "private"));
    await fs.writeFile(
      path.join(repoRoot, filePath),
      JSON.stringify({
        relayUrl: "wss://relay.qa.example",
        roomId: "123e4567-e89b-42d3-a456-426614174000",
        driverPrivateKey: DRIVER_PRIVATE_KEY,
        sutPrivateKey: SUT_PRIVATE_KEY,
      }),
      { mode: 0o600 },
    );

    await expect(readBuzzQaCredentialFile({ filePath, repoRoot })).resolves.toMatchObject({
      relayUrl: "wss://relay.qa.example",
      driverPrivateKey: DRIVER_PRIVATE_KEY,
      sutPrivateKey: SUT_PRIVATE_KEY,
    });
  });

  it("does not echo malformed file contents", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-buzz-qa-"));
    tempDirs.push(repoRoot);
    const filePath = "buzz.json";
    const secret = "private-key-material-must-not-leak";
    await fs.writeFile(path.join(repoRoot, filePath), `{${secret}`, { mode: 0o600 });

    await expect(readBuzzQaCredentialFile({ filePath, repoRoot })).rejects.not.toThrow(secret);
    await expect(readBuzzQaCredentialFile({ filePath, repoRoot })).rejects.toThrow(
      "is not valid JSON",
    );
    try {
      await readBuzzQaCredentialFile({ filePath, repoRoot });
    } catch (error) {
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
