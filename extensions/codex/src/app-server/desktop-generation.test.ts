import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import { createCodexDesktopGenerationOwner } from "./desktop-generation-owner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Codex desktop generation owner", () => {
  afterEach(() => vi.useRealTimers());

  it("restarts reconciliation when invalidated during a snapshot read", async () => {
    vi.useFakeTimers();
    const reads: ReturnType<typeof deferred<string>>[] = [];
    const changed = vi.fn();
    const owner = createCodexDesktopGenerationOwner({
      readFingerprint: () => {
        const read = deferred<string>();
        reads.push(read);
        return read.promise;
      },
      onGenerationChange: changed,
    });

    owner.markDirty();
    const pending = owner.wait();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    owner.markDirty();
    reads[0]?.resolve("X");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]?.resolve("X");
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    reads[2]?.resolve("Y");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(reads).toHaveLength(4));
    reads[3]?.resolve("Y");

    await expect(pending).resolves.toEqual({ epoch: 1, fingerprint: "Y" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("coalesces waiters and keeps the generation for an unchanged snapshot", async () => {
    vi.useFakeTimers();
    const fingerprint = "X";
    const readFingerprint = vi.fn(async () => fingerprint);
    const changed = vi.fn();
    const owner = createCodexDesktopGenerationOwner({
      readFingerprint,
      onGenerationChange: changed,
    });
    const initial = owner.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await initial;
    readFingerprint.mockClear();

    owner.markDirty();
    const pending = Promise.all([owner.wait(), owner.wait()]);
    await vi.advanceTimersByTimeAsync(1_000);
    const [left, right] = await pending;

    expect(left).toBe(right);
    expect(left).toEqual({ epoch: 1, fingerprint: "X" });
    expect(readFingerprint).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps a failed refresh dirty for the next waiter", async () => {
    vi.useFakeTimers();
    const readFingerprint = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient update"))
      .mockResolvedValue("Y");
    const owner = createCodexDesktopGenerationOwner({
      readFingerprint,
    });
    owner.markDirty();

    await expect(owner.wait()).rejects.toThrow("transient update");
    const retry = owner.wait();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retry).resolves.toEqual({ epoch: 1, fingerprint: "Y" });
  });

  it("detects changes in every desktop candidate that can supply a fallback artifact", async () => {
    await withTempDir("openclaw-codex-generation-fingerprint-", async (root) => {
      const chatGpt = candidate(root, "ChatGPT.app");
      const codex = candidate(root, "Codex.app");
      await Promise.all([
        writeCommand(chatGpt.appServerCommandPath, "chatgpt-x"),
        writeCommand(codex.appServerCommandPath, "codex-x"),
      ]);
      const initial = await readMacOSDesktopGenerationFingerprint([chatGpt, codex]);

      await writeCommand(codex.appServerCommandPath, "codex-y");
      await expect(readMacOSDesktopGenerationFingerprint([chatGpt, codex])).resolves.not.toBe(
        initial,
      );
    });
  });

  it("watches the stable parent chain for every fingerprinted artifact", () => {
    const fixture = candidate("/Applications", "ChatGPT.app");
    const servicePath = path.join(fixture.appBundlePath, "service", "Computer Use.app");
    const watchPaths = resolveMacOSDesktopGenerationWatchPaths([
      { ...fixture, computerUseServiceAppPaths: [servicePath] },
    ]);

    expect(watchPaths).toEqual(
      expect.arrayContaining([
        "/Applications",
        fixture.appBundlePath,
        path.dirname(fixture.appServerCommandPath),
        path.join(fixture.bundledMarketplacePath, ".agents", "plugins"),
        path.join(fixture.bundledMarketplacePath, "plugins", "computer-use", ".codex-plugin"),
        servicePath,
        path.join(servicePath, "Contents"),
        path.join(
          servicePath,
          "Contents",
          "SharedSupport",
          "SkyComputerUseClient.app",
          "Contents",
          "MacOS",
        ),
      ]),
    );
  });
});

function candidate(root: string, appName: "ChatGPT.app" | "Codex.app") {
  const appBundlePath = path.join(root, appName);
  return {
    appName,
    appBundlePath,
    appServerCommandPath: path.join(appBundlePath, "Contents", "Resources", "codex"),
    bundledMarketplacePath: path.join(appBundlePath, "marketplace"),
    computerUseServiceAppPaths: [],
  };
}

async function writeCommand(commandPath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, contents);
}
