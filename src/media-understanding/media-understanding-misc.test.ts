// Misc media-understanding tests cover scope matching and attachment cache SSRF
// and local path safety behavior.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsSafe from "../infra/fs-safe.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { MediaAttachmentCache } from "./attachments.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";

describe("media understanding scope", () => {
  it("normalizes chatType", () => {
    expect(normalizeMediaUnderstandingChatType("channel")).toBe("channel");
    expect(normalizeMediaUnderstandingChatType("dm")).toBe("direct");
    expect(normalizeMediaUnderstandingChatType("room")).toBeUndefined();
  });

  it("matches channel chatType explicitly", () => {
    const scope = {
      rules: [{ action: "deny", match: { chatType: "channel" } }],
    } as Parameters<typeof resolveMediaUnderstandingScope>[0]["scope"];

    expect(resolveMediaUnderstandingScope({ scope, chatType: "channel" })).toBe("deny");
  });
});

const originalFetch = globalThis.fetch;
const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

function restoreProcessState() {
  stateDirEnvSnapshot.restore();
}

async function withLocalAttachmentCache(
  prefix: string,
  run: (params: {
    cache: MediaAttachmentCache;
    attachmentPath: string;
    canonicalAttachmentPath: string;
  }) => Promise<void>,
) {
  await withTestDir({ prefix }, async (base) => {
    const allowedRoot = path.join(base, "allowed");
    const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.writeFile(attachmentPath, "ok");
    const canonicalAttachmentPath = await fs.realpath(attachmentPath).catch(() => attachmentPath);

    const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
      localPathRoots: [allowedRoot],
    });

    await run({ cache, attachmentPath, canonicalAttachmentPath });
  });
}

describe("media understanding attachments SSRF", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreProcessState();
    vi.restoreAllMocks();
  });

  it("blocks private IP URLs before fetching", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = withFetchPreconnect(fetchSpy);

    const cache = new MediaAttachmentCache([{ index: 0, url: "http://127.0.0.1/secret.jpg" }]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows RFC2544 benchmark-range URLs only when media fetch policy opts in", async () => {
    const url = "http://198.18.0.153/file.jpg";
    const deniedCache = new MediaAttachmentCache([{ index: 0, url }]);
    await expect(
      deniedCache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/private|internal|blocked/i);

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("image", {
        headers: { "content-type": "image/jpeg" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const allowedCache = new MediaAttachmentCache([{ index: 0, url }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await allowedCache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });
    expect(result).toStrictEqual({
      buffer: Buffer.from("image"),
      classification: { mime: "image/jpeg", class: "image" },
      mime: "image/jpeg",
      fileName: "file.jpg",
      size: 5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses fetched content type instead of wildcard selection hints", async () => {
    const url = "http://198.18.0.153/image";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("image", {
        headers: { "content-type": "image/png" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "image/*" }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe("image/png");
    expect(result.fileName).toBe("image.png");
  });

  it("keeps the attachment's concrete MIME when the download reports octet-stream", async () => {
    const url = "http://198.18.0.153/export";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"report":"q3"}', {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/json" }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    // A generic download header is a non-answer; the declared concrete type
    // must survive so allowlists and extraction see application/json.
    expect(result.classification.mime).toBe("application/json");
    expect(result.classification.class).toBe("text");
  });

  it("prefers the channel-declared MIME over a generic fetched text header", async () => {
    const url = "http://198.18.0.153/export.data";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"report":"q4"}', {
        headers: { "content-type": "text/plain" },
      }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy);
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/json" }], {
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    // Channel declaration outranks transport Content-Type: a JSON-only
    // allowlist must keep matching when a proxy relabels the download.
    expect(result.classification.mime).toBe("application/json");
  });

  it("reads local attachments inside configured roots", async () => {
    await withLocalAttachmentCache("openclaw-media-cache-allowed-", async ({ cache }) => {
      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("ok");
      expect(result.localPath).toBeDefined();
    });
  });

  it("carries no local path when a blocked path recovers through the URL fallback", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-blocked-" }, async (base) => {
      const blockedPath = path.join(base, "outside-roots", "report.doc");
      await fs.mkdir(path.dirname(blockedPath), { recursive: true });
      await fs.writeFile(blockedPath, "blocked");
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response("remote-bytes", {
          headers: { "content-type": "application/msword" },
        }),
      );
      globalThis.fetch = withFetchPreconnect(fetchSpy);

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: blockedPath, url: "http://198.18.0.153/report.doc" }],
        {
          localPathRoots: [path.join(base, "allowed-only")],
          includeDefaultLocalPathRoots: false,
          ssrfPolicy: { allowRfc2544BenchmarkRange: true },
        },
      );

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });

      // Bytes recovered remotely; the blocked path must never surface as a
      // self-serve target in model context.
      expect(result.buffer.toString()).toBe("remote-bytes");
      expect(result.localPath).toBeUndefined();
    });
  });

  it("resolves relative attachment paths against the provided workspaceDir", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-workspace-" }, async (base) => {
      const workspaceDir = path.join(base, "workspace");
      const attachmentPath = path.join(workspaceDir, "media", "inbound", "report.pdf");
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: "media/inbound/report.pdf", workspaceDir }],
        { localPathRoots: [workspaceDir] },
      );

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("ok");
    });
  });

  it("resolves each relative attachment against its own workspace", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-workspaces-" }, async (base) => {
      const workspaces = ["first", "second"].map((name) => path.join(base, name));
      await Promise.all(
        workspaces.map(async (workspaceDir, index) => {
          await fs.mkdir(workspaceDir, { recursive: true });
          await fs.writeFile(path.join(workspaceDir, "attachment.txt"), `slot-${index}`);
        }),
      );
      const cache = new MediaAttachmentCache(
        workspaces.map((workspaceDir, index) => ({
          index,
          path: "attachment.txt",
          workspaceDir,
        })),
        { localPathRoots: workspaces },
      );

      await expect(
        Promise.all(
          workspaces.map((_workspaceDir, attachmentIndex) =>
            cache.getBuffer({ attachmentIndex, maxBytes: 1024, timeoutMs: 1000 }),
          ),
        ),
      ).resolves.toEqual([
        expect.objectContaining({ buffer: Buffer.from("slot-0") }),
        expect.objectContaining({ buffer: Buffer.from("slot-1") }),
      ]);
    });
  });

  it("resolves existing state-relative media paths when cwd differs from state dir", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-state-relative-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/telegram.jpg";
      const attachmentPath = path.join(stateDir, relativePath);
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(attachmentPath, "state-media");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const cache = new MediaAttachmentCache([{ index: 0, path: relativePath }], {
        localPathRoots: [path.join(stateDir, "media")],
      });

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("state-media");
      expect(result.fileName).toBe("telegram.jpg");
    });
  });

  it("resolves managed inbound media URI attachments", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-managed-inbound-" }, async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      const saved = await saveMediaBuffer(Buffer.from("managed-media"), "text/plain", "inbound");

      const cache = new MediaAttachmentCache(
        [{ index: 0, path: `media://inbound/${encodeURIComponent(saved.id)}` }],
        {
          localPathRoots: [path.join(stateDir, "media")],
        },
      );

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

      expect(result.buffer.toString()).toBe("managed-media");
      expect(result.fileName).toBe(saved.id);
    });
  });

  it("blocks nested managed inbound media URI attachments", async () => {
    const cache = new MediaAttachmentCache([
      { index: 0, path: "media://inbound/nested%2Ffile.pdf" },
    ]);

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("keeps cwd-relative fallback when a state-relative candidate does not exist", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-cwd-relative-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/local.jpg";
      const attachmentPath = path.join(cwd, relativePath);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
      await fs.writeFile(attachmentPath, "cwd-media");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const cache = new MediaAttachmentCache([{ index: 0, path: relativePath }], {
        localPathRoots: [path.join(cwd, "media")],
      });

      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });
      expect(result.buffer.toString()).toBe("cwd-media");
      expect(result.fileName).toBe("local.jpg");
    });
  });

  it("prefers an existing cwd-relative attachment over a state-relative collision", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-relative-collision-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/photo.jpg";
      const cwdPath = path.join(cwd, relativePath);
      const statePath = path.join(stateDir, relativePath);
      await fs.mkdir(path.dirname(cwdPath), { recursive: true });
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(cwdPath, "cwd-media");
      await fs.writeFile(statePath, "state-media");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const cache = new MediaAttachmentCache([{ index: 0, path: relativePath }], {
        localPathRoots: [path.join(cwd, "media"), path.join(stateDir, "media")],
      });
      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

      expect(result.buffer.toString()).toBe("cwd-media");
    });
  });

  it("falls back to state media when a cwd collision is outside allowed roots", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-blocked-cwd-collision-" }, async (base) => {
      const stateDir = path.join(base, "state");
      const cwd = path.join(base, "cwd");
      const relativePath = "media/inbound/photo.jpg";
      const cwdPath = path.join(cwd, relativePath);
      const statePath = path.join(stateDir, relativePath);
      await fs.mkdir(path.dirname(cwdPath), { recursive: true });
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(cwdPath, "blocked-cwd-media");
      await fs.writeFile(statePath, "state-media");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      const cache = new MediaAttachmentCache([{ index: 0, path: relativePath }], {
        localPathRoots: [path.join(stateDir, "media")],
      });
      const result = await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

      expect(result.buffer.toString()).toBe("state-media");
    });
  });

  it("blocks local attachments outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const cache = new MediaAttachmentCache([{ index: 0, path: "/etc/passwd" }], {
      localPathRoots: ["/Users/*/Library/Messages/Attachments"],
    });

    await expect(
      cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("blocks directory attachments even inside configured roots", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-dir-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "nested");
      await fs.mkdir(attachmentPath, { recursive: true });

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/not a regular file/i);
    });
  });

  it("blocks symlink escapes that resolve outside configured roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTestDir({ prefix: "openclaw-media-cache-symlink-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const outsidePath = "/etc/passwd";
      const symlinkPath = path.join(allowedRoot, "note.txt");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.symlink(outsidePath, symlinkPath);

      const cache = new MediaAttachmentCache([{ index: 0, path: symlinkPath }], {
        localPathRoots: [allowedRoot],
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/outside allowed roots/i);
    });
  });

  it("opens local attachments with nofollow on posix", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withLocalAttachmentCache(
      "openclaw-media-cache-flags-",
      async ({ cache, canonicalAttachmentPath }) => {
        const openSpy = vi.spyOn(fs, "open");

        await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

        expect(openSpy).toHaveBeenCalled();
        const [openedPath, openedFlags] = mockCall(openSpy);
        expect(await fs.realpath(String(openedPath)).catch(() => String(openedPath))).toBe(
          canonicalAttachmentPath,
        );
        // fs-safe 0.5.2 may add O_NONBLOCK so a raced FIFO cannot pin a worker.
        expect(Number(openedFlags) & ~fsConstants.O_NONBLOCK).toBe(
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      },
    );
  });

  it("rejects local attachments when canonicalization fails", async () => {
    await withTestDir({ prefix: "openclaw-media-cache-realpath-failure-" }, async (base) => {
      const allowedRoot = path.join(base, "allowed");
      const attachmentPath = path.join(allowedRoot, "voice-note.m4a");
      await fs.mkdir(allowedRoot, { recursive: true });
      await fs.writeFile(attachmentPath, "ok");

      const cache = new MediaAttachmentCache([{ index: 0, path: attachmentPath }], {
        localPathRoots: [allowedRoot],
      });
      vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
        if (params.filePath === attachmentPath) {
          throw new Error("EACCES");
        }
        throw new Error(`Unexpected attachment path: ${params.filePath}`);
      });

      await expect(
        cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 }),
      ).rejects.toThrow(/could not be canonicalized/i);
    });
  });
});
