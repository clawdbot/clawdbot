// Gateway assistant-avatar tests cover selected-source precedence and safe fallbacks.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openGatewayAssistantAvatar, resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString("base64")}`;
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
type GatewayAssistantAvatarProjection = ReturnType<typeof resolveGatewayAssistantAvatar>;

function createWorkspace(): { workspace: string; cfg: OpenClawConfig } {
  const root = tempRoots.make("openclaw-gateway-avatar-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  return {
    workspace,
    cfg: { agents: { list: [{ id: "main", workspace }] } },
  };
}

function projectAvatar(cfg: OpenClawConfig): GatewayAssistantAvatarProjection {
  const identity = resolveAssistantIdentity({ cfg, agentId: "main" });
  return resolveGatewayAssistantAvatar({ cfg, identity });
}

describe("resolveGatewayAssistantAvatar", () => {
  it("inlines the selected local file", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), REAL_PNG);
    cfg.agents!.list![0]!.identity = { avatar: "avatar.png" };

    expect(projectAvatar(cfg)).toMatchObject({
      avatar: REAL_PNG_DATA_URL,
      resolution: { kind: "local", source: "avatar.png" },
    });
  });

  it("leaves a pinned local descriptor for the route owner", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), REAL_PNG);
    cfg.agents!.list![0]!.identity = { avatar: "avatar.png" };
    const identity = resolveAssistantIdentity({ cfg, agentId: "main" });

    const projected = openGatewayAssistantAvatar({ cfg, identity });
    expect(projected).toMatchObject({
      resolution: { kind: "local", source: "avatar.png" },
      openedFile: { fd: expect.any(Number) },
    });
    if (!projected.openedFile) {
      throw new Error("expected a pinned avatar descriptor");
    }
    try {
      expect(fs.readFileSync(projected.openedFile.fd)).toEqual(REAL_PNG);
    } finally {
      fs.closeSync(projected.openedFile.fd);
    }
  });

  it("preserves a selected emoji over a lower-priority IDENTITY.md file", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "identity.png"), REAL_PNG);
    fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");
    cfg.agents!.list![0]!.identity = { emoji: "🦞" };

    expect(projectAvatar(cfg)).toEqual({ avatar: "🦞", resolution: null });
  });

  it.each([
    ["remote URL", "https://example.com/avatar.png"],
    ["data URI", REAL_PNG_DATA_URL],
  ])("preserves a selected %s", (_name, avatar) => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar };

    expect(projectAvatar(cfg)).toMatchObject({ avatar, resolution: { source: avatar } });
  });

  it("uses a configured emoji when the selected local path is rejected", () => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar: "missing.png", emoji: "🦞" };

    expect(projectAvatar(cfg)).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it.each([
    ["unsupported_data_url", "data:text/plain,avatar"],
    ["unsupported_uri", "slack://avatar.png"],
  ])("rejects %s before local-path handling", (reason, avatar) => {
    const { cfg } = createWorkspace();

    expect(
      resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar, emoji: "🦞" },
      }),
    ).toEqual({
      avatar: "🦞",
      resolution: { kind: "none", reason, source: avatar },
    });
  });

  it("never maps a rejected local path back to an authenticated avatar route", () => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar: "missing.png" };

    expect(projectAvatar(cfg)).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "missing", source: "missing.png" },
    });
  });

  it("reports pinned-read rejection instead of claiming the avatar is local", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "original.png"), REAL_PNG);
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "avatar.png"));
    cfg.agents!.list![0]!.identity = { avatar: "avatar.png" };

    expect(projectAvatar(cfg)).toEqual({
      avatar: "A",
      resolution: { kind: "none", reason: "unreadable", source: "avatar.png" },
    });
  });

  it.each(["A", "PS", "🦞"])("keeps the %s text avatar free of file metadata", (avatar) => {
    const { cfg } = createWorkspace();
    cfg.agents!.list![0]!.identity = { avatar };

    expect(projectAvatar(cfg)).toEqual({ avatar, resolution: null });
  });

  it("preserves same-origin avatar routes and applies the configured base path", () => {
    const { cfg } = createWorkspace();
    cfg.gateway = { controlUi: { basePath: "/openclaw" } };

    expect(
      resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar: "/avatar/main" },
      }),
    ).toEqual({ avatar: "/openclaw/avatar/main", resolution: null });
    expect(
      resolveGatewayAssistantAvatar({
        cfg,
        identity: { agentId: "main", avatar: "/openclaw/avatar/main" },
      }),
    ).toEqual({ avatar: "/openclaw/avatar/main", resolution: null });
  });
});
