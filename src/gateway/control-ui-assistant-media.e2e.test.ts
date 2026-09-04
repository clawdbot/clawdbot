// Control UI assistant media e2e tests verify scoped media-ticket access through gateway HTTP routes.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as mediaMime from "@openclaw/media-core/mime";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import * as safeFiles from "../infra/fs-safe.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import * as localMediaAccess from "../media/local-media-access.js";
import * as mediaProbe from "../media/media-probe.js";
import * as playbackTranscode from "../media/playback-transcode.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Control UI assistant media e2e", () => {
  test("does not grant media access from ordinary tool-call arguments", async () => {
    const workspace = tempDirs.make("media-tool-arguments-");
    const source = path.join(workspace, "private.txt");
    await fs.writeFile(source, "not an attachment");
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { main: {}, research: { workspace } },
    };
    testState.sessionStorePath = path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.sqlite");
    const sessionKey = "agent:research:main";
    const sessionId = "media-tool-arguments";
    await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } } });
    await appendTranscriptMessage(
      { agentId: "research", sessionId, sessionKey, storePath: testState.sessionStorePath },
      {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-private", name: "read", arguments: { path: source } },
          ],
          timestamp: Date.now(),
        },
      },
    );
    await withGatewayServer(
      async ({ port }) => {
        const client = await connectGatewayClient({
          url: "ws://127.0.0.1:" + port,
          token: CONTROL_UI_E2E_TOKEN,
          scopes: ["operator.read"],
        });
        const opens = vi.spyOn(safeFiles, "openLocalFileSafely");
        try {
          expect(await client.request("assistant.media.get", { source, sessionKey })).toEqual({
            available: false,
            code: "session_unavailable",
            reason: "Session unavailable",
          });
          expect(opens).not.toHaveBeenCalled();
        } finally {
          opens.mockRestore();
          await disconnectGatewayClient(client);
        }
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
  test("revokes media authority after awaited work before rendition opens and byte streams", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    const mediaDir = path.join(stateDir, "media", "late-revocation");
    await fs.mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "source.wav");
    const rendition = path.join(mediaDir, "rendition.m4a");
    await fs.writeFile(source, "source audio bytes");
    await fs.writeFile(rendition, "cached rendition bytes");
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    const sessionId = "late-media-revocation";

    await withGatewayServer(
      async ({ port }) => {
        for (const boundary of ["mime", "transcode", "rendition-close", "head-close"] as const) {
          await writeSessionStore({
            entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } },
          });
          await appendTranscriptMessage(
            { agentId: "main", sessionId, sessionKey, storePath: testState.sessionStorePath },
            {
              message: {
                role: "assistant",
                content: [{ type: "audio", url: source }],
                timestamp: Date.now(),
              },
            },
          );
          const client = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token: CONTROL_UI_E2E_TOKEN,
            scopes: ["operator.read"],
          });
          try {
            const minted = await client.request<{ mediaTicket: string }>("assistant.media.get", {
              source,
              sessionKey,
            });
            const url = new URL("/__openclaw__/assistant-media", `http://127.0.0.1:${port}`);
            url.searchParams.set("source", source);
            url.searchParams.set("mediaTicket", minted.mediaTicket);
            const method = boundary === "head-close" ? "HEAD" : "GET";
            if (boundary === "transcode" || boundary === "rendition-close") {
              url.searchParams.set("playback", "1");
            }
            let revoke = false;
            const revokeSession = async () => {
              if (revoke) {
                await writeSessionStore({ entries: {} });
              }
            };
            const detectMime = mediaMime.detectMime;
            vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
              const mime = await detectMime(params);
              if (boundary === "mime") {
                await revokeSession();
              }
              return mime;
            });
            // Keep the real HTTP/auth/file/stream boundaries; substitute only
            // the asynchronous codec service with an already-produced rendition.
            vi.spyOn(playbackTranscode, "resolvePlaybackTranscode").mockImplementation(async () => {
              if (boundary === "transcode") {
                await revokeSession();
              }
              return {
                kind: "transcoded",
                path: rendition,
                contentType: "audio/mp4",
                extension: ".m4a",
              };
            });
            const streams = vi.fn();
            const closes = vi.fn();
            const openLocalFileSafely = safeFiles.openLocalFileSafely;
            const opens = vi
              .spyOn(safeFiles, "openLocalFileSafely")
              .mockImplementation(async (params) => {
                const opened = await openLocalFileSafely(params);
                const createReadStream = opened.handle.createReadStream.bind(opened.handle);
                vi.spyOn(opened.handle, "createReadStream").mockImplementation((options) => {
                  streams(params.filePath);
                  return createReadStream(options);
                });
                const close = opened.handle.close.bind(opened.handle);
                vi.spyOn(opened.handle, "close").mockImplementation(async () => {
                  await close();
                  closes(params.filePath);
                  if (
                    (boundary === "rendition-close" || boundary === "head-close") &&
                    params.filePath === source
                  ) {
                    await revokeSession();
                  }
                });
                return opened;
              });
            const intact = await fetch(url, { method });
            expect(intact.status, boundary).toBe(200);
            expect(await intact.text()).toBe(
              boundary === "head-close"
                ? ""
                : boundary === "mime"
                  ? "source audio bytes"
                  : "cached rendition bytes",
            );
            expect(streams).toHaveBeenCalledTimes(boundary === "head-close" ? 0 : 1);
            opens.mockClear();
            streams.mockClear();
            closes.mockClear();
            revoke = true;
            const revoked = await fetch(url, { method });
            expect(revoked.status, boundary).toBe(401);
            expect(await revoked.text()).toBe(boundary === "head-close" ? "" : "Unauthorized");
            expect(revoked.headers.get("etag")).toBeNull();
            expect(streams, boundary).not.toHaveBeenCalled();
            if (boundary === "transcode") {
              expect(opens.mock.calls.map(([params]) => params.filePath)).toEqual([source]);
            }
            expect(closes).toHaveBeenCalledWith(source);
            if (boundary === "rendition-close") {
              expect(closes).toHaveBeenCalledWith(rendition);
            }
          } finally {
            vi.restoreAllMocks();
            await disconnectGatewayClient(client);
          }
        }
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });

  test("rejects issuance after awaited open, MIME, probe, and close boundaries", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("Gateway test state is required");
    }
    const mediaDir = path.join(stateDir, "media", "issuance-revocation");
    await fs.mkdir(mediaDir, { recursive: true });
    const source = path.join(mediaDir, "voice.wav");
    await fs.writeFile(source, "audio fixture");
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    const sessionKey = "agent:main:main";
    const sessionId = "issuance-revocation";
    await withGatewayServer(
      async ({ port }) => {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: CONTROL_UI_E2E_TOKEN,
          scopes: ["operator.read"],
        });
        try {
          for (const boundary of ["open", "mime", "probe", "close"] as const) {
            await writeSessionStore({
              entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } },
            });
            await appendTranscriptMessage(
              { agentId: "main", sessionId, sessionKey, storePath: testState.sessionStorePath },
              {
                message: {
                  role: "assistant",
                  content: [{ type: "audio", url: source }],
                  timestamp: Date.now(),
                },
              },
            );
            const revoke = async () => await writeSessionStore({ entries: {} });
            const open = safeFiles.openLocalFileSafely;
            const reads = vi.fn();
            const closes = vi.fn();
            vi.spyOn(safeFiles, "openLocalFileSafely").mockImplementation(async (params) => {
              const opened = await open(params);
              const read = opened.handle.read.bind(opened.handle);
              vi.spyOn(opened.handle, "read").mockImplementation(
                (...args: Parameters<typeof read>) => {
                  reads();
                  return read(...args);
                },
              );
              const close = opened.handle.close.bind(opened.handle);
              vi.spyOn(opened.handle, "close").mockImplementation(async () => {
                await close();
                closes();
                if (boundary === "close") {
                  await revoke();
                }
              });
              if (boundary === "open") {
                await revoke();
              }
              return opened;
            });
            const detectMime = mediaMime.detectMime;
            vi.spyOn(mediaMime, "detectMime").mockImplementation(async (params) => {
              const mime = await detectMime(params);
              if (boundary === "mime") {
                await revoke();
              }
              return mime;
            });
            const probe = mediaProbe.probePlaybackMediaFileDescriptor;
            const probes = vi
              .spyOn(mediaProbe, "probePlaybackMediaFileDescriptor")
              .mockImplementation(async (...args) => {
                const result = await probe(...args);
                if (boundary === "probe") {
                  await revoke();
                }
                return result;
              });
            const playback = vi.spyOn(playbackTranscode, "resolvePlaybackModeForSource");
            try {
              expect(
                await client.request("assistant.media.get", { source, sessionKey }),
                boundary,
              ).toEqual({
                available: false,
                code: "session_unavailable",
                reason: "Session unavailable",
              });
              expect(closes, boundary).toHaveBeenCalledOnce();
              if (boundary === "open") {
                expect(reads).not.toHaveBeenCalled();
              }
              if (boundary === "open" || boundary === "mime") {
                expect(probes).not.toHaveBeenCalled();
              }
              if (boundary !== "close") {
                expect(playback).not.toHaveBeenCalled();
              }
            } finally {
              vi.restoreAllMocks();
            }
          }
        } finally {
          await disconnectGatewayClient(client);
        }
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });

  test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "测试 ticketed (final).txt");
    const homeRelativeSource = `~/${path.relative(resolveRequiredHomeDir(), filePath).split(path.sep).join("/")}`;
    await fs.writeFile(filePath, "ticketed control ui media\n", "utf8");
    const agentWorkspace = tempDirs.make("assistant-media-agent-");
    const researchWorkspace = tempDirs.make("assistant-media-research-");
    const outsideRoot = tempDirs.make("assistant-media-outside-");
    const workspaceFile = path.join(agentWorkspace, "workspace-only.txt");
    const researchFile = path.join(researchWorkspace, "research-only.txt");
    const unreferencedResearchFile = path.join(researchWorkspace, "unreferenced.txt");
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await fs.writeFile(workspaceFile, "workspace media\n", "utf8");
    await fs.writeFile(researchFile, "research media\n", "utf8");
    await fs.writeFile(unreferencedResearchFile, "unreferenced media\n", "utf8");
    await fs.writeFile(outsideFile, "outside media\n", "utf8");
    testState.agentsConfig = {
      ownership: "explicit",
      entries: {
        main: { workspace: agentWorkspace },
        research: { workspace: researchWorkspace },
      },
    };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    await writeSessionStore({
      entries: {
        "agent:main:main": {
          sessionId: "assistant-media-main-session",
          updatedAt: Date.now(),
        },
        "agent:research:main": {
          sessionId: "assistant-media-research-session",
          updatedAt: Date.now(),
        },
      },
    });
    await appendTranscriptMessage(
      {
        agentId: "main",
        sessionId: "assistant-media-main-session",
        sessionKey: "agent:main:main",
        storePath: testState.sessionStorePath,
      },
      {
        message: {
          role: "assistant",
          content: [
            { type: "image", url: homeRelativeSource },
            { type: "image", url: workspaceFile },
            { type: "image", url: outsideFile },
          ],
          timestamp: Date.now(),
        },
      },
    );
    await appendTranscriptMessage(
      {
        agentId: "research",
        sessionId: "assistant-media-research-session",
        sessionKey: "agent:research:main",
        storePath: testState.sessionStorePath,
      },
      {
        message: {
          role: "toolResult",
          toolCallId: "research-media",
          toolName: "media_fixture",
          content: [
            { type: "image", url: homeRelativeSource },
            { type: "image", url: researchFile },
            { type: "text", text: `MEDIA:${unreferencedResearchFile}` },
          ],
          timestamp: Date.now(),
        },
      },
    );

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(homeRelativeSource);
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: CONTROL_UI_E2E_TOKEN,
          scopes: ["operator.read"],
        });
        const payload = await client.request<{
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        }>("assistant.media.get", {
          source: homeRelativeSource,
          sessionKey: "agent:research:main",
        });
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();

        const mainMedia = await client.request<{ available: boolean }>("assistant.media.get", {
          source: workspaceFile,
          sessionKey: "agent:main:main",
        });
        expect(mainMedia.available, JSON.stringify(mainMedia)).toBe(true);
        await expect(
          client.request("assistant.media.get", {
            source: outsideFile,
            sessionKey: "agent:main:main",
          }),
        ).resolves.toEqual({
          available: false,
          code: "outside-allowed-folders",
          reason: "Outside allowed folders",
        });

        const researchPayload = await client.request<{
          available?: boolean;
          mediaTicket?: string;
        }>("assistant.media.get", {
          source: researchFile,
          sessionKey: "agent:research:main",
        });
        expect(researchPayload.available).toBe(true);
        await expect(
          client.request("assistant.media.get", {
            source: unreferencedResearchFile,
            sessionKey: "agent:research:main",
          }),
        ).resolves.toEqual({
          available: false,
          code: "session_unavailable",
          reason: "Session unavailable",
        });
        const researchTicketed = await fetch(
          `${route}?source=${encodeURIComponent(researchFile)}&mediaTicket=${encodeURIComponent(researchPayload.mediaTicket ?? "")}`,
        );
        expect(researchTicketed.status).toBe(200);
        expect(await researchTicketed.text()).toBe("research media\n");

        const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
        expect(withoutTicket.status).toBe(401);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(ticketed.headers.get("content-disposition")).toBe(
          `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
        );
        expect(await ticketed.text()).toBe("ticketed control ui media\n");

        const fileUrl = pathToFileURL(filePath).href;
        for (const source of [
          fileUrl,
          fileUrl.replace(/^file:/u, "FILE:"),
          fileUrl.replace(/^file:\/\//u, "file:"),
          fileUrl.replace(/^file:\/\//u, "FILE:"),
        ]) {
          const equivalent = await fetch(
            `${route}?source=${encodeURIComponent(source)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          );
          expect(equivalent.status, source).toBe(200);
          expect(await equivalent.text()).toBe("ticketed control ui media\n");
        }
        for (const source of ["file://evil-host/etc/hostname", "FILE://evil-host/etc/hostname"]) {
          const remoteHost = await fetch(`${route}?source=${encodeURIComponent(source)}`, {
            headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
          });
          expect(remoteHost.status, source).toBe(404);
        }

        const ranged = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { headers: { Range: "bytes=9-15" } },
        );
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("accept-ranges")).toBe("bytes");
        expect(ranged.headers.get("content-range")).toBe("bytes 9-15/26");
        expect(ranged.headers.get("content-length")).toBe("7");
        expect(ranged.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
        expect(await ranged.text()).toBe("control");

        const head = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { method: "HEAD" },
        );
        expect(head.status).toBe(200);
        expect(head.headers.get("accept-ranges")).toBe("bytes");
        expect(head.headers.get("content-length")).toBe("26");
        expect(head.headers.get("etag")).toBe(ranged.headers.get("etag"));
        expect(await head.text()).toBe("");

        for (const method of ["GET", "HEAD"]) {
          const notModified = await fetch(
            `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
            {
              method,
              headers: {
                "If-None-Match": `W/${ranged.headers.get("etag")}`,
                Range: "bytes=9-15",
                "If-Range": '"stale"',
              },
            },
          );
          expect(notModified.status).toBe(304);
          expect(notModified.headers.get("etag")).toBe(ranged.headers.get("etag"));
          expect(notModified.headers.get("content-length")).toBeNull();
          expect(await notModified.text()).toBe("");
        }

        // Revoke the selected session after real root validation, while the
        // WebSocket availability request is still awaiting that boundary.
        const assertAllowed = localMediaAccess.assertLocalMediaAllowed;
        const allowed = vi
          .spyOn(localMediaAccess, "assertLocalMediaAllowed")
          .mockImplementation(async (...args) => {
            await assertAllowed(...args);
            await writeSessionStore({ entries: {} });
          });
        const opens = vi.spyOn(safeFiles, "openLocalFileSafely");
        try {
          const revoked = await client.request("assistant.media.get", {
            source: researchFile,
            sessionKey: "agent:research:main",
          });
          expect(allowed).toHaveBeenCalled();
          expect.soft(opens).not.toHaveBeenCalled();
          expect(revoked).toEqual({
            available: false,
            code: "session_unavailable",
            reason: "Session unavailable",
          });
        } finally {
          allowed.mockRestore();
          opens.mockRestore();
        }
        const revokedResearchTicket = await fetch(
          `${route}?source=${encodeURIComponent(researchFile)}&mediaTicket=${encodeURIComponent(researchPayload.mediaTicket ?? "")}`,
        );
        expect(revokedResearchTicket.status).toBe(401);

        const emptyFilePath = path.join(mediaDir, "empty.bin");
        await fs.writeFile(emptyFilePath, Buffer.alloc(0));
        const empty = await fetch(`${route}?source=${encodeURIComponent(emptyFilePath)}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(empty.status).toBe(200);
        expect(empty.headers.get("content-length")).toBe("0");
        expect((await empty.arrayBuffer()).byteLength).toBe(0);

        const otherFilePath = path.join(mediaDir, "other-preview.txt");
        await fs.writeFile(otherFilePath, "other media\n", "utf8");
        const wrongSource = await fetch(
          `${route}?source=${encodeURIComponent(otherFilePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(wrongSource.status).toBe(401);
        await disconnectGatewayClient(client);
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
});
