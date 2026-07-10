// Internal avatar-file tests cover pinned reads, limits, and workspace boundaries.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { AVATAR_MAX_BYTES, AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-policy.js";
import {
  openLocalAgentAvatarFile,
  readOpenedLocalAgentAvatarDataUrl,
  resolveAgentAvatarUrlFromSource,
} from "./identity-avatar-file.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function createWorkspace(): { workspace: string; cfg: OpenClawConfig } {
  const root = tempRoots.make("openclaw-avatar-file-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  return {
    workspace,
    cfg: { agents: { list: [{ id: "main", workspace }] } },
  };
}

describe("local agent avatar files", () => {
  it("reads a pinned local file with the shared MIME policy", () => {
    const { cfg, workspace } = createWorkspace();
    const body = Buffer.from("avatar");
    fs.writeFileSync(path.join(workspace, "avatar.jpeg"), body);

    expect(resolveAgentAvatarUrlFromSource(cfg, "main", "avatar.jpeg")).toBe(
      `data:image/jpeg;base64,${body.toString("base64")}`,
    );
  });

  it("passes through only bounded image data URLs for agent-list projections", () => {
    const { cfg } = createWorkspace();
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(resolveAgentAvatarUrlFromSource(cfg, "main", exact)).toBe(exact);
    expect(resolveAgentAvatarUrlFromSource(cfg, "main", `${exact}A`)).toBeUndefined();
    expect(resolveAgentAvatarUrlFromSource(cfg, "main", "data:text/plain,avatar")).toBeUndefined();
  });

  it("closes the pinned descriptor after inlining", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), "avatar");
    const opened = openLocalAgentAvatarFile({ cfg, agentId: "main", source: "avatar.png" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error("expected a pinned avatar descriptor");
    }

    expect(readOpenedLocalAgentAvatarDataUrl(opened.file)).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
    expect(() => fs.fstatSync(opened.file.fd)).toThrow();
  });

  it("rejects symlink escapes and hardlinks", () => {
    const { cfg, workspace } = createWorkspace();
    const outside = path.join(path.dirname(workspace), "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workspace, "symlink.png"));
    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "symlink.png" })).toEqual({
      ok: false,
      reason: "outside_workspace",
    });

    fs.writeFileSync(path.join(workspace, "original.png"), "avatar");
    fs.linkSync(path.join(workspace, "original.png"), path.join(workspace, "hardlink.png"));
    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "hardlink.png" })).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("rejects files above the shared byte limit before reading", () => {
    const { cfg, workspace } = createWorkspace();
    fs.writeFileSync(path.join(workspace, "avatar.png"), Buffer.alloc(AVATAR_MAX_BYTES + 1));

    expect(openLocalAgentAvatarFile({ cfg, agentId: "main", source: "avatar.png" })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
