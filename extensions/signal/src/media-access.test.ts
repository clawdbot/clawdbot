import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSignalApprovalReactionTargetsForTest } from "./approval-reactions.js";
import { signalPlugin } from "./channel.js";
import { registerSignalReplyContext } from "./reply-authors.js";
import { sendMessageSignal } from "./send.js";

const SIGNAL_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

type SignalMediaContext = {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  replyToId?: string;
  deps?: { signal: typeof sendMessageSignal };
};

type SignalRpcEnvelope = {
  id?: string | number;
  method?: string;
  params?: {
    account?: string;
    recipient?: string[];
    message?: string;
    attachments?: string[];
    quoteTimestamp?: number;
    quoteAuthor?: string;
    quoteMessage?: string;
  };
};

const SIGNAL_MEDIA_ADAPTERS = [
  {
    name: "message adapter",
    deliver: async (context: SignalMediaContext) => {
      const send = signalPlugin.message?.send?.media;
      if (!send) {
        throw new Error("Signal message media adapter is unavailable");
      }
      return await send(context);
    },
  },
  {
    name: "formatted outbound adapter",
    deliver: async (context: SignalMediaContext) => {
      const send = signalPlugin.outbound?.sendFormattedMedia;
      if (!send) {
        throw new Error("Signal formatted media adapter is unavailable");
      }
      return await send(context);
    },
  },
  {
    name: "attached-result outbound adapter",
    deliver: async (context: SignalMediaContext) => {
      const send = signalPlugin.outbound?.sendMedia;
      if (!send) {
        throw new Error("Signal attached-result media adapter is unavailable");
      }
      return await send(context);
    },
  },
] as const;

describe("Signal host-owned outbound media access", () => {
  let state: OpenClawTestState;
  let server: http.Server;
  let cfg: OpenClawConfig;
  let requests: Array<{ envelope: SignalRpcEnvelope; attachment: Buffer | undefined }>;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-signal-media-access-",
    });
    requests = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      request.on("end", () => {
        void (async () => {
          const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SignalRpcEnvelope;
          const attachmentPath = envelope.params?.attachments?.[0];
          requests.push({
            envelope,
            attachment: attachmentPath ? await fs.readFile(attachmentPath) : undefined,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: envelope.id,
              result: { timestamp: 1700000000999, results: [{ type: "SUCCESS" }] },
            }),
          );
        })().catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(error));
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Signal test server did not expose a TCP port");
    }
    cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15550001111",
              transport: { kind: "external-native", url: `http://127.0.0.1:${address.port}` },
            },
          },
        },
      },
    };
  });

  afterEach(async () => {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      clearSignalApprovalReactionTargetsForTest();
      vi.restoreAllMocks();
      await state?.cleanup();
    }
  });

  function createContext(overrides: Partial<SignalMediaContext> = {}): SignalMediaContext {
    return {
      cfg,
      to: "+15551234567",
      text: "Workspace attachment",
      mediaUrl: "chart.png",
      ...overrides,
    };
  }

  it.each(SIGNAL_MEDIA_ADAPTERS)(
    "delivers approved workspace bytes through the real $name and preserves native quotes",
    async ({ deliver }) => {
      const sourcePath = path.join(state.workspaceDir, "chart.png");
      const conflictingRoot = state.path("conflicting-root");
      await fs.mkdir(conflictingRoot);
      await fs.writeFile(sourcePath, SIGNAL_IMAGE);
      const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
      const conflictingReader = vi.fn(async () => Buffer.from("untrusted bytes"));
      const mediaAccess = {
        localRoots: [state.workspaceDir],
        workspaceDir: state.workspaceDir,
        readFile: approvedReader,
      } satisfies OutboundMediaAccess;
      const send = vi.fn(sendMessageSignal);
      await registerSignalReplyContext({
        accountId: "default",
        to: "+15551234567",
        replyToId: "1700000000001",
        author: "+15550002222",
        body: "original message",
      });

      const result = await deliver(
        createContext({
          mediaAccess,
          mediaLocalRoots: [conflictingRoot],
          mediaReadFile: conflictingReader,
          replyToId: "1700000000001",
          deps: { signal: send },
        }),
      );

      expect(result).toMatchObject({ messageId: "1700000000999" });
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[2].mediaAccess).toBe(mediaAccess);
      expect(send.mock.calls[0]?.[2].mediaLocalRoots).toEqual([conflictingRoot]);
      expect(send.mock.calls[0]?.[2].mediaReadFile).toBe(conflictingReader);
      expect(approvedReader).toHaveBeenCalledExactlyOnceWith(sourcePath);
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.attachment).toEqual(SIGNAL_IMAGE);
      expect(requests[0]?.envelope).toMatchObject({
        method: "send",
        params: {
          account: "+15550001111",
          recipient: ["+15551234567"],
          quoteTimestamp: 1700000000001,
          quoteAuthor: "+15550002222",
          quoteMessage: "original message",
        },
      });
    },
  );

  it.each(SIGNAL_MEDIA_ADAPTERS)(
    "rejects traversal before reading or contacting Signal through the $name",
    async ({ deliver }) => {
      await fs.writeFile(state.path("outside.png"), SIGNAL_IMAGE);
      const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));
      const conflictingReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));

      await expect(
        deliver(
          createContext({
            mediaUrl: "../outside.png",
            mediaLocalRoots: [state.root],
            mediaReadFile: conflictingReader,
            mediaAccess: {
              localRoots: [state.workspaceDir],
              workspaceDir: state.workspaceDir,
              readFile: approvedReader,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "path-not-allowed" });

      expect(approvedReader).not.toHaveBeenCalled();
      expect(conflictingReader).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    },
  );

  it("rejects workspace symlinks that resolve outside the approved root", async () => {
    const outsidePath = state.path("outside.png");
    await fs.writeFile(outsidePath, SIGNAL_IMAGE);
    await fs.symlink(outsidePath, path.join(state.workspaceDir, "linked.png"));
    const approvedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));

    await expect(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({
          mediaUrl: "linked.png",
          mediaAccess: {
            localRoots: [state.workspaceDir],
            workspaceDir: state.workspaceDir,
            readFile: approvedReader,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "path-not-allowed" });

    expect(approvedReader).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("rejects host readers that do not declare an approved root", async () => {
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    const unrootedReader = vi.fn(async (filePath: string) => await fs.readFile(filePath));

    await expect(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({
          mediaAccess: { workspaceDir: state.workspaceDir, readFile: unrootedReader },
        }),
      ),
    ).rejects.toThrow("Host media read requires explicit localRoots");

    expect(unrootedReader).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("preserves reader-free Gateway workspace capabilities", async () => {
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    const mediaAccess = { localRoots: [state.workspaceDir], workspaceDir: state.workspaceDir };
    const send = vi.fn(sendMessageSignal);

    await expect(
      SIGNAL_MEDIA_ADAPTERS[2].deliver(createContext({ mediaAccess, deps: { signal: send } })),
    ).resolves.toMatchObject({ messageId: "1700000000999" });

    expect(send.mock.calls[0]?.[2].mediaAccess).toBe(mediaAccess);
    expect(send.mock.calls[0]?.[2].mediaAccess?.readFile).toBeUndefined();
    expect(send.mock.calls[0]?.[2].mediaReadFile).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.attachment).toEqual(SIGNAL_IMAGE);
  });

  it.each([
    { name: "sensitive log", filename: "secret.log", contents: "sensitive host data" },
    { name: "forged PDF", filename: "forged.pdf", contents: "not a real PDF" },
    { name: "untrusted HTML", filename: "untrusted.html", contents: "<html>private</html>" },
  ])("rejects a $name before contacting Signal", async ({ filename, contents }) => {
    await fs.writeFile(path.join(state.workspaceDir, filename), contents);

    await expect(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({
          mediaUrl: filename,
          mediaAccess: {
            localRoots: [state.workspaceDir],
            workspaceDir: state.workspaceDir,
            readFile: async (filePath) => await fs.readFile(filePath),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "path-not-allowed" });

    expect(requests).toHaveLength(0);
  });

  it("propagates host-reader failures without contacting Signal", async () => {
    await fs.writeFile(path.join(state.workspaceDir, "chart.png"), SIGNAL_IMAGE);
    const deniedReader = vi.fn(async (_filePath: string): Promise<Buffer> => {
      throw new Error("host denied this attachment");
    });

    await expect(
      SIGNAL_MEDIA_ADAPTERS[0].deliver(
        createContext({
          mediaAccess: {
            localRoots: [state.workspaceDir],
            workspaceDir: state.workspaceDir,
            readFile: deniedReader,
          },
        }),
      ),
    ).rejects.toThrow("host denied this attachment");

    expect(deniedReader).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });
});
