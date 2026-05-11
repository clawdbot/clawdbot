import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const { resolveChannelMessageToolMediaSourceParamKeysMock } = vi.hoisted(() => ({
  resolveChannelMessageToolMediaSourceParamKeysMock: vi.fn(() => ["avatarPath", "avatarUrl"]),
}));

vi.mock("../../channels/plugins/message-action-discovery.js", () => ({
  resolveChannelMessageToolMediaSourceParamKeys: resolveChannelMessageToolMediaSourceParamKeysMock,
}));

import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  resolveExtraActionMediaSourceParamKeys,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;
const matrixMediaSourceParamKeys = ["avatarPath", "avatarUrl"] as const;

describe("message action media helpers", () => {
  beforeEach(() => {
    resolveChannelMessageToolMediaSourceParamKeysMock.mockClear();
  });

  it("skips plugin media discovery when args only use standard action params", () => {
    expect(
      resolveExtraActionMediaSourceParamKeys({
        cfg,
        action: "send",
        channel: "workspace",
        args: {
          channel: "workspace",
          target: "#C12345678",
          message: "hi",
          media: "https://example.com/photo.png",
        },
      }),
    ).toStrictEqual([]);
    expect(resolveChannelMessageToolMediaSourceParamKeysMock).not.toHaveBeenCalled();
  });

  it("discovers plugin media params when args include an extension-owned field", () => {
    expect(
      resolveExtraActionMediaSourceParamKeys({
        cfg,
        action: "set-profile",
        channel: "matrix",
        args: {
          channel: "matrix",
          avatarPath: "/workspace/avatars/profile.png",
        },
      }),
    ).toEqual(["avatarPath", "avatarUrl"]);
    expect(resolveChannelMessageToolMediaSourceParamKeysMock).toHaveBeenCalledWith({
      cfg,
      action: "set-profile",
      channel: "matrix",
      accountId: undefined,
      sessionKey: undefined,
      sessionId: undefined,
      agentId: undefined,
      requesterSenderId: undefined,
      senderIsOwner: undefined,
    });
  });

  it("prefers sandbox media policy when sandbox roots are non-blank", () => {
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "  /tmp/workspace  ",
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "sandbox",
      sandboxRoot: "/tmp/workspace",
    });
    expect(
      resolveAttachmentMediaPolicy({
        sandboxRoot: "   ",
        mediaLocalRoots: ["/tmp/a"],
      }),
    ).toEqual({
      mode: "host",
      mediaAccess: {
        localRoots: ["/tmp/a"],
      },
      mediaLocalRoots: ["/tmp/a"],
    });
  });

  it("preserves explicit any local roots for host read opt-ins", () => {
    const mediaReadFile = async () => Buffer.from("x");
    expect(
      resolveAttachmentMediaPolicy({
        mediaLocalRoots: "any",
        mediaReadFile,
      }),
    ).toEqual({
      mode: "host",
      mediaAccess: {
        readFile: mediaReadFile,
      },
      mediaLocalRoots: "any",
      mediaReadFile,
    });
  });

  maybeIt("normalizes sandbox media lists and dedupes resolved workspace paths", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-list-"));
    try {
      await expect(
        normalizeSandboxMediaList({
          values: [" data:text/plain;base64,QQ== "],
        }),
      ).rejects.toThrow(/data:/i);
      await expect(
        normalizeSandboxMediaList({
          values: [" file:///workspace/assets/photo.png ", "/workspace/assets/photo.png", " "],
          sandboxRoot: ` ${sandboxRoot} `,
        }),
      ).resolves.toEqual([path.join(sandboxRoot, "assets", "photo.png")]);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("normalizes mediaUrl and fileUrl sandbox media params", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-alias-"));
    try {
      const args: Record<string, unknown> = {
        mediaUrl: " file:///workspace/assets/photo.png ",
        fileUrl: "/workspace/docs/report.pdf",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot: ` ${sandboxRoot} `,
        },
      });

      expect(args.mediaUrl).toBe(path.join(sandboxRoot, "assets", "photo.png"));
      expect(args.fileUrl).toBe(path.join(sandboxRoot, "docs", "report.pdf"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("normalizes extension event image sandbox media params", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-image-"));
    try {
      const args: Record<string, unknown> = {
        image: " file:///workspace/assets/event-cover.png ",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot: ` ${sandboxRoot} `,
        },
      });

      expect(args.image).toBe(path.join(sandboxRoot, "assets", "event-cover.png"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("normalizes extension avatarPath and avatarUrl sandbox media params", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-"));
    try {
      const args: Record<string, unknown> = {
        avatarPath: "/workspace/avatars/profile.png",
        avatarUrl: "file:///workspace/avatars/remote-avatar.jpg",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatarPath).toBe(path.join(sandboxRoot, "avatars", "profile.png"));
      expect(args.avatarUrl).toBe(path.join(sandboxRoot, "avatars", "remote-avatar.jpg"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("collects host media source hints from the shared media-source key set", () => {
    expect(
      collectActionMediaSourceHints(
        {
          media: " /workspace/uploads/photo.png ",
          filePath: "",
          image: "file:///workspace/assets/event-cover.png",
          avatarPath: "/workspace/avatars/profile.png",
          avatar_url: "mxc://matrix.org/abc123def456",
          ignored: "/workspace/not-included.png",
        },
        matrixMediaSourceParamKeys,
      ),
    ).toEqual([
      " /workspace/uploads/photo.png ",
      "file:///workspace/assets/event-cover.png",
      "/workspace/avatars/profile.png",
      "mxc://matrix.org/abc123def456",
    ]);
  });

  maybeIt("normalizes extension snake_case avatar_path and avatar_url aliases", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-snake-"));
    try {
      const args: Record<string, unknown> = {
        avatar_path: "/workspace/avatars/profile.png",
        avatar_url: "file:///workspace/avatars/remote-avatar.jpg",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatar_path).toBe(path.join(sandboxRoot, "avatars", "profile.png"));
      expect(args.avatar_url).toBe(path.join(sandboxRoot, "avatars", "remote-avatar.jpg"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("prefers canonical extension media params over invalid snake_case aliases", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-canonical-"));
    try {
      const args: Record<string, unknown> = {
        avatarUrl: "https://example.com/avatars/profile.png",
        avatar_url: "data:text/plain;base64,QQ==",
        avatarPath: "/workspace/avatars/profile.png",
        avatar_path: "data:text/plain;base64,QQ==",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatarUrl).toBe("https://example.com/avatars/profile.png");
      expect(args.avatarPath).toBe(path.join(sandboxRoot, "avatars", "profile.png"));
      expect(args.avatar_url).toBe("data:text/plain;base64,QQ==");
      expect(args.avatar_path).toBe("data:text/plain;base64,QQ==");
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("keeps remote HTTP avatarUrl unchanged under sandbox normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-remote-"));
    try {
      const args: Record<string, unknown> = {
        avatarUrl: "https://example.com/avatars/profile.png",
        avatarPath: "/workspace/avatars/local.png",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatarUrl).toBe("https://example.com/avatars/profile.png");
      expect(args.avatarPath).toBe(path.join(sandboxRoot, "avatars", "local.png"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt("keeps mxc:// avatarUrl unchanged under sandbox normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-avatar-mxc-"));
    try {
      const args: Record<string, unknown> = {
        avatarUrl: "mxc://matrix.org/abc123def456",
        avatarPath: "/workspace/avatars/local.png",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot,
        },
        extraParamKeys: matrixMediaSourceParamKeys,
      });

      expect(args.avatarUrl).toBe("mxc://matrix.org/abc123def456");
      expect(args.avatarPath).toBe(path.join(sandboxRoot, "avatars", "local.png"));
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  maybeIt(
    "keeps remote HTTP mediaUrl and fileUrl aliases unchanged under sandbox normalization",
    async () => {
      const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-remote-alias-"));
      try {
        const args: Record<string, unknown> = {
          mediaUrl: "https://example.com/assets/photo.png?sig=1",
          fileUrl: "https://example.com/docs/report.pdf?sig=2",
        };

        await normalizeSandboxMediaParams({
          args,
          mediaPolicy: {
            mode: "sandbox",
            sandboxRoot,
          },
        });

        expect(args.mediaUrl).toBe("https://example.com/assets/photo.png?sig=1");
        expect(args.fileUrl).toBe("https://example.com/docs/report.pdf?sig=2");
      } finally {
        await fs.rm(sandboxRoot, { recursive: true, force: true });
      }
    },
  );

  it("uses mediaUrl and fileUrl aliases when inferring attachment filenames", async () => {
    const mediaArgs: Record<string, unknown> = {
      mediaUrl: "https://example.com/pic.png",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args: mediaArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(mediaArgs.filename).toBe("pic.png");

    const fileArgs: Record<string, unknown> = {
      fileUrl: "https://example.com/docs/report.pdf",
    };
    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args: fileArgs,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(fileArgs.filename).toBe("report.pdf");
  });

  it("falls back to extension-based attachment names for remote-host file URLs", async () => {
    const args: Record<string, unknown> = {
      media: "file://attacker/share/photo.png",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "workspace",
      args,
      action: "sendAttachment",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("attachment");
  });

  it("hydrates reply attachments through the resolver so threaded sends don't bypass mediaLocalRoots", async () => {
    // Locks in coverage for the reply-with-attachment path: when an agent
    // calls message(action: "reply") with a `path`/`media`/etc., the
    // resolver — not the channel runtime — must run. Pre-PR this was
    // gated only on sendAttachment/setGroupIcon/upload-file, letting
    // imessage reply forward an arbitrary host path to imsg.
    const args: Record<string, unknown> = {
      mediaUrl: "https://example.com/cute.png",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "imessage",
      args,
      action: "reply",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("cute.png");
  });

  it("does not fall back caption->message on reply (reply has its own text field)", async () => {
    // sendAttachment uses caption as the body text and falls back from
    // message -> caption when the agent only supplied `message`. Reply has
    // its own `text`/`message` field, so caption fallback would invent a
    // bogus caption param on the reply payload.
    const args: Record<string, unknown> = {
      mediaUrl: "https://example.com/cute.png",
      message: "🦞",
    };

    await hydrateAttachmentParamsForAction({
      cfg,
      channel: "imessage",
      args,
      action: "reply",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.caption).toBeUndefined();
  });
});

describe("message action sandbox media hydration", () => {
  maybeIt("rejects symlink retarget escapes after sandbox media normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-sandbox-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-outside-"));
    try {
      const insideDir = path.join(sandboxRoot, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "note.txt"), "INSIDE_SECRET", "utf8");
      await fs.writeFile(path.join(outsideRoot, "note.txt"), "OUTSIDE_SECRET", "utf8");

      const slotLink = path.join(sandboxRoot, "slot");
      await fs.symlink(insideDir, slotLink);

      const args: Record<string, unknown> = {
        media: "slot/note.txt",
      };
      const mediaPolicy = {
        mode: "sandbox",
        sandboxRoot,
      } as const;

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy,
      });

      await fs.rm(slotLink, { recursive: true, force: true });
      await fs.symlink(outsideRoot, slotLink);

      await expect(
        hydrateAttachmentParamsForAction({
          cfg,
          channel: "workspace",
          args,
          action: "sendAttachment",
          mediaPolicy,
        }),
      ).rejects.toThrow(/outside workspace root|outside/i);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
