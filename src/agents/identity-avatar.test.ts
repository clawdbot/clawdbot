// Exercises agent avatar resolution, workspace containment, and public redaction.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import {
  resolveAgentAvatar,
  resolveAgentAvatarFromSource,
  resolvePublicAgentAvatarSource,
} from "./identity-avatar.js";
import { resolveAgentAvatarUrl } from "./identity-avatar-projection.js";

const AVATAR_MAX_DATA_URL_CHARS = 4 * Math.ceil(AVATAR_MAX_BYTES / 3) + 64;

async function writeFile(filePath: string, contents = "avatar") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf-8");
}

async function expectLocalAvatarPath(
  cfg: OpenClawConfig,
  workspace: string,
  expectedRelativePath: string,
  opts?: Parameters<typeof resolveAgentAvatar>[2],
) {
  // Compare realpaths so symlinks or temp-dir normalization cannot hide an
  // avatar escaping the configured workspace.
  const workspaceReal = await fs.realpath(workspace);
  const resolved = resolveAgentAvatar(cfg, "main", opts);
  expect(resolved.kind).toBe("local");
  if (resolved.kind === "local") {
    const resolvedReal = await fs.realpath(resolved.filePath);
    expect(path.relative(workspaceReal, resolvedReal)).toBe(expectedRelativePath);
  }
}

const tempRoots: string[] = [];

async function createTempAvatarRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-"));
  tempRoots.push(root);
  return root;
}

async function setupUiAndConfigAvatarWorkspace() {
  const root = await createTempAvatarRoot();
  const workspace = path.join(root, "work");
  const uiAvatarPath = path.join(workspace, "ui-avatar.png");
  const cfgAvatarPath = path.join(workspace, "cfg-avatar.png");
  await writeFile(uiAvatarPath);
  await writeFile(cfgAvatarPath);
  const cfg: OpenClawConfig = {
    ui: { assistant: { avatar: "ui-avatar.png" } },
    agents: { list: [{ id: "main", workspace, identity: { avatar: "cfg-avatar.png" } }] },
  };
  return { cfg, workspace };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("resolveAgentAvatar", () => {
  it("resolves local avatar from config when inside workspace", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "main.png");
    await writeFile(avatarPath);

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            workspace,
            identity: { avatar: "avatars/main.png" },
          },
        ],
      },
    };

    await expectLocalAvatarPath(cfg, workspace, path.join("avatars", "main.png"));
  });

  it("rejects avatars outside the workspace", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    const outsidePath = path.join(root, "outside.png");
    await writeFile(outsidePath);

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            workspace,
            identity: { avatar: outsidePath },
          },
        ],
      },
    };

    const resolved = resolveAgentAvatar(cfg, "main");
    expect(resolved.kind).toBe("none");
    if (resolved.kind === "none") {
      expect(resolved.reason).toBe("outside_workspace");
    }
  });

  it("falls back to IDENTITY.md when config has no avatar", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "fallback.png");
    await writeFile(avatarPath);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      "- Avatar: avatars/fallback.png\n",
      "utf-8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace }],
      },
    };

    await expectLocalAvatarPath(cfg, workspace, path.join("avatars", "fallback.png"));
  });

  it("returns missing for non-existent local avatar files", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace, identity: { avatar: "avatars/missing.png" } }],
      },
    };

    const resolved = resolveAgentAvatar(cfg, "main");
    expect(resolved.kind).toBe("none");
    if (resolved.kind === "none") {
      expect(resolved.reason).toBe("missing");
      expect(resolved.source).toBe("avatars/missing.png");
      expect(resolvePublicAgentAvatarSource(resolved)).toBe("avatars/missing.png");
    }
  });

  it("redacts unsafe public avatar sources", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    const outsidePath = path.join(root, "outside.png");
    await writeFile(outsidePath);

    const absolute = resolveAgentAvatar(
      {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: outsidePath } }],
        },
      },
      "main",
    );
    expect(absolute.kind).toBe("none");
    expect(resolvePublicAgentAvatarSource(absolute)).toBeUndefined();

    // Public status/UI surfaces may report remote/data origins, but local
    // absolute paths and traversal attempts stay hidden.
    expect(
      resolvePublicAgentAvatarSource({
        kind: "remote",
        source: "https://example.com/avatar.png?token=secret",
      }),
    ).toBe("remote URL");
    expect(
      resolvePublicAgentAvatarSource({
        kind: "data",
        source: "data:image/png;base64,aaaaaaaa",
      }),
    ).toBe("data:image/png;base64,...");
    expect(
      resolvePublicAgentAvatarSource({
        kind: "none",
        source: "../secret.png",
      }),
    ).toBeUndefined();
    expect(
      resolvePublicAgentAvatarSource({
        kind: "none",
        source: "file:///Users/test/private/avatar.png",
      }),
    ).toBeUndefined();
  });

  it("rejects local avatars larger than max bytes", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "too-big.png");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES + 1));

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace, identity: { avatar: "avatars/too-big.png" } }],
      },
    };

    const resolved = resolveAgentAvatar(cfg, "main");
    expect(resolved.kind).toBe("none");
    if (resolved.kind === "none") {
      expect(resolved.reason).toBe("too_large");
    }
  });

  it("projects an avatar at the exact local byte limit without exceeding the data URL cap", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatars", "max.png");
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES));
    const resolved = resolveAgentAvatar(
      {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "avatars/max.png" } }],
        },
      },
      "main",
    );
    const dataUrl = resolveAgentAvatarUrl(resolved);

    expect(dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl?.length).toBeLessThanOrEqual(AVATAR_MAX_DATA_URL_CHARS);
  });

  it("accepts remote and data avatars", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", identity: { avatar: "https://example.com/avatar.png" } },
          { id: "data", identity: { avatar: "data:image/png;base64,aaaa" } },
        ],
      },
    };

    const remote = resolveAgentAvatar(cfg, "main");
    expect(remote.kind).toBe("remote");
    if (remote.kind === "remote") {
      expect(remote.source).toBe("https://example.com/avatar.png");
    }

    const data = resolveAgentAvatar(cfg, "data");
    expect(data.kind).toBe("data");
    if (data.kind === "data") {
      expect(data.source).toBe("data:image/png;base64,aaaa");
    }
  });

  it("resolves local avatar from ui.assistant.avatar when no agents.list identity is set", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "ui-avatar.png");
    await writeFile(avatarPath);

    const cfg: OpenClawConfig = {
      ui: { assistant: { avatar: "ui-avatar.png" } },
      agents: { list: [{ id: "main", workspace }] },
    };

    await expectLocalAvatarPath(cfg, workspace, "ui-avatar.png", { includeUiOverride: true });
  });

  it("ui.assistant.avatar ignored without includeUiOverride (outbound callers)", async () => {
    const { cfg, workspace } = await setupUiAndConfigAvatarWorkspace();

    // Without the opt-in, outbound callers get the per-agent identity avatar,
    // not the UI override.
    await expectLocalAvatarPath(cfg, workspace, "cfg-avatar.png");
  });

  it("ui.assistant.avatar takes priority over agents.list identity.avatar with includeUiOverride", async () => {
    const { cfg, workspace } = await setupUiAndConfigAvatarWorkspace();

    await expectLocalAvatarPath(cfg, workspace, "ui-avatar.png", { includeUiOverride: true });
  });

  it("prefers non-default agent avatar over ui.assistant.avatar with includeUiOverride", async () => {
    const root = await createTempAvatarRoot();
    const mainWorkspace = path.join(root, "main");
    const workerWorkspace = path.join(root, "worker");
    await writeFile(path.join(mainWorkspace, "ui-avatar.png"));
    await writeFile(path.join(workerWorkspace, "worker-avatar.png"));

    const cfg: OpenClawConfig = {
      ui: { assistant: { avatar: "ui-avatar.png" } },
      agents: {
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "worker", workspace: workerWorkspace, identity: { avatar: "worker-avatar.png" } },
        ],
      },
    };

    const workspaceReal = await fs.realpath(workerWorkspace);
    const resolved = resolveAgentAvatar(cfg, "worker", { includeUiOverride: true });
    expect(resolved.kind).toBe("local");
    if (resolved.kind === "local") {
      const resolvedReal = await fs.realpath(resolved.filePath);
      expect(path.relative(workspaceReal, resolvedReal)).toBe("worker-avatar.png");
    }
  });

  it("falls back to ui.assistant.avatar for non-default agents without their own avatar", async () => {
    const root = await createTempAvatarRoot();
    const mainWorkspace = path.join(root, "main");
    const workerWorkspace = path.join(root, "worker");
    await writeFile(path.join(workerWorkspace, "ui-avatar.png"));

    const cfg: OpenClawConfig = {
      ui: { assistant: { avatar: "ui-avatar.png" } },
      agents: {
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "worker", workspace: workerWorkspace },
        ],
      },
    };

    const workspaceReal = await fs.realpath(workerWorkspace);
    const resolved = resolveAgentAvatar(cfg, "worker", { includeUiOverride: true });
    expect(resolved.kind).toBe("local");
    if (resolved.kind === "local") {
      const resolvedReal = await fs.realpath(resolved.filePath);
      expect(path.relative(workspaceReal, resolvedReal)).toBe("ui-avatar.png");
    }
  });

  it("ui.assistant.avatar takes priority over IDENTITY.md avatar with includeUiOverride", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const uiAvatarPath = path.join(workspace, "ui-avatar.png");
    const identityAvatarPath = path.join(workspace, "identity-avatar.png");
    await writeFile(uiAvatarPath);
    await writeFile(identityAvatarPath);
    await fs.writeFile(
      path.join(workspace, "IDENTITY.md"),
      "- Avatar: identity-avatar.png\n",
      "utf-8",
    );

    const cfg: OpenClawConfig = {
      ui: { assistant: { avatar: "ui-avatar.png" } },
      agents: { list: [{ id: "main", workspace }] },
    };

    await expectLocalAvatarPath(cfg, workspace, "ui-avatar.png", { includeUiOverride: true });
  });
});

describe("agent avatar browser projection", () => {
  it("projects local, remote, and data sources without changing their semantics", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await writeFile(path.join(workspace, "avatars", "main.png"), "avatar");
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace, identity: { avatar: "avatars/main.png" } }],
      },
    };
    const expectedLocal = `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`;
    const local = resolveAgentAvatar(cfg, "main");

    expect(resolveAgentAvatarUrl(local)).toBe(expectedLocal);
    expect(
      resolveAgentAvatarUrl(resolveAgentAvatarFromSource(cfg, "main", "avatars/main.png")),
    ).toBe(expectedLocal);
    expect(
      resolveAgentAvatarUrl(
        resolveAgentAvatarFromSource(cfg, "main", "https://example.com/avatar.png"),
      ),
    ).toBe("https://example.com/avatar.png");
    expect(
      resolveAgentAvatarUrl(
        resolveAgentAvatarFromSource(cfg, "main", "data:image/png;base64,aaaa"),
      ),
    ).toBe("data:image/png;base64,aaaa");
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["svg", "image/svg+xml"],
  ] as const)("uses the shared MIME policy for .%s files", async (extension, mime) => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await writeFile(path.join(workspace, `avatar.${extension}`), "avatar");
    const resolved = resolveAgentAvatar(
      {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: `avatar.${extension}` } }],
        },
      },
      "main",
    );

    expect(resolveAgentAvatarUrl(resolved)).toBe(
      `data:${mime};base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  it("does not project rejected local avatar paths", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    await fs.mkdir(workspace, { recursive: true });
    const missing = resolveAgentAvatar(
      {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "avatars/missing.png" } }],
        },
      },
      "main",
    );

    expect(resolveAgentAvatarUrl(missing)).toBeUndefined();
  });

  it("rechecks the workspace boundary when a resolved path is replaced before reading", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const avatarPath = path.join(workspace, "avatar.png");
    const outsidePath = path.join(root, "outside.png");
    await writeFile(avatarPath, "avatar");
    await writeFile(outsidePath, "secret");
    const resolved = resolveAgentAvatar(
      {
        agents: { list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }] },
      },
      "main",
    );
    expect(resolved.kind).toBe("local");

    await fs.rm(avatarPath);
    try {
      await fs.symlink(outsidePath, avatarPath);
    } catch {
      return;
    }
    expect(resolveAgentAvatarUrl(resolved)).toBeUndefined();
  });

  it("rejects hardlinked avatar files at the read boundary", async () => {
    const root = await createTempAvatarRoot();
    const workspace = path.join(root, "work");
    const outsidePath = path.join(root, "outside.png");
    const avatarPath = path.join(workspace, "avatar.png");
    await writeFile(outsidePath, "secret");
    await fs.mkdir(workspace, { recursive: true });
    try {
      await fs.link(outsidePath, avatarPath);
    } catch {
      return;
    }
    const resolved = resolveAgentAvatar(
      {
        agents: { list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }] },
      },
      "main",
    );
    expect(resolved.kind).toBe("local");
    expect(resolveAgentAvatarUrl(resolved)).toBeUndefined();
  });
});
