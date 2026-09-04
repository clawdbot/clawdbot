import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readImageMetadataFromHeader } from "../media/image-ops.js";
import { encodePngRgba } from "../media/png-encode.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { handleControlUiAvatarRequest } from "./control-ui.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// Two 2×2 red/blue frames encoded with img2webp; VP8X animation flag and timing are retained.
const ANIMATED_WEBP = Buffer.from(
  "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=",
  "base64",
);

it.each(
  [
    { format: "APNG", filename: "avatar.png", mime: "image/apng", body: APNG_BYTES },
    { format: "animated WebP", filename: "avatar.webp", mime: "image/webp", body: ANIMATED_WEBP },
  ].flatMap((fixture) =>
    ["local", "data"].map((sourceKind) => Object.assign({}, fixture, { sourceKind })),
  ),
)(
  "preserves all frames of a $sourceKind $format avatar",
  async ({ filename, mime, body, sourceKind }) => {
    const workspace = tempRoots.make("openclaw-avatar-animation-");
    fs.writeFileSync(path.join(workspace, filename), body);
    const avatar =
      sourceKind === "local" ? filename : `data:${mime};base64,${body.toString("base64")}`;
    const config: OpenClawConfig = {
      agents: { list: [{ id: "main", workspace, identity: { avatar } }] },
    };
    const url = resolveGatewayAssistantAvatar({
      cfg: config,
      identity: resolveAssistantIdentity({ cfg: config, agentId: "main" }),
      httpBasePath: "",
    }).avatar;
    const response = makeMockHttpResponse();
    await handleControlUiAvatarRequest(
      { url, method: "GET", headers: {} } as IncomingMessage,
      response.res,
      { config },
    );
    expect(response.res.statusCode).toBe(200);
    expect(response.end).toHaveBeenCalledWith(body);
  },
);

it.each(["local", "data"])(
  "serves a cached authenticated thumbnail for a versioned %s avatar",
  async (sourceKind) => {
    const workspace = tempRoots.make("openclaw-avatar-thumbnail-");
    const pixels = randomBytes(640 * 640 * 4);
    const original = encodePngRgba(pixels, 640, 640);
    const avatarPath = path.join(workspace, "avatar.png");
    fs.writeFileSync(avatarPath, original);
    const config: OpenClawConfig = {
      gateway: { controlUi: { basePath: "/control" } },
      agents: {
        list: [
          {
            id: "main",
            workspace,
            identity: {
              avatar:
                sourceKind === "local"
                  ? "avatar.png"
                  : `data:image/png;base64,${original.toString("base64")}`,
            },
          },
        ],
      },
    };
    const project = () =>
      resolveGatewayAssistantAvatar({
        cfg: config,
        identity: resolveAssistantIdentity({ cfg: config, agentId: "main" }),
        httpBasePath: "/control",
      }).avatar;
    const url = project();
    expect(url).toMatch(/^\/control\/avatar\/main\?v=[a-f0-9]+$/);
    const request = async (
      options: { method?: string; etag?: string; authorized?: boolean; url?: string } = {},
    ) => {
      const response = makeMockHttpResponse();
      await handleControlUiAvatarRequest(
        {
          url: options.url ?? url,
          method: options.method ?? "GET",
          headers: {
            ...(options.authorized === false ? {} : { authorization: "Bearer test-token" }),
            ...(options.etag ? { "if-none-match": options.etag } : {}),
          },
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
        response.res,
        {
          config,
          basePath: "/control",
          auth: { mode: "token", token: "test-token", allowTailscale: false },
        },
      );
      return response;
    };
    const first = await request();
    expect(first.res.statusCode).toBe(200);
    const thumbnail = first.end.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(thumbnail)).toBe(true);
    expect(readImageMetadataFromHeader(thumbnail as Buffer)).toEqual({ width: 128, height: 128 });
    expect((thumbnail as Buffer).length).toBeLessThan(original.length / 10);
    expect(first.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "private, max-age=31536000, immutable",
    );
    expect(first.setHeader).toHaveBeenCalledWith("vary", "Authorization, Cookie");
    const etag = first.setHeader.mock.calls.find(([name]) => name === "etag")?.[1] as string;
    expect(etag).toBeTruthy();

    const read = vi.spyOn(fs, "read");
    const cached = await request();
    expect(cached.end).toHaveBeenCalledWith(thumbnail);
    expect(read).not.toHaveBeenCalled();
    const head = await request({ method: "HEAD" });
    expect(head.setHeader).toHaveBeenCalledWith(
      "content-length",
      String((thumbnail as Buffer).length),
    );
    expect(head.end.mock.calls[0]?.[0]).toBeUndefined();
    expect((await request({ etag })).res.statusCode).toBe(304);
    expect((await request({ etag, authorized: false })).res.statusCode).toBe(401);

    const replacement = encodePngRgba(Buffer.alloc(640 * 640 * 4, 120), 640, 640);
    if (sourceKind === "local") {
      fs.writeFileSync(path.join(workspace, "replacement.png"), replacement);
      fs.renameSync(path.join(workspace, "replacement.png"), avatarPath);
    } else {
      config.agents!.list![0]!.identity!.avatar = `data:image/png;base64,${replacement.toString("base64")}`;
    }
    const replacedUrl = project();
    expect(replacedUrl).not.toBe(url);
    const replaced = await request({ url: replacedUrl, etag });
    expect(replaced.res.statusCode).toBe(200);
    expect(replaced.end.mock.calls[0]?.[0]).not.toEqual(thumbnail);
    const stale = await request();
    expect(stale.setHeader).toHaveBeenCalledWith("cache-control", "private, no-cache");
  },
);
