import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { resolveHttpProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const state = vi.hoisted(() => ({
  loaded: vi.fn(),
  auth: vi.fn(),
  placements: vi.fn(),
}));
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: state.loaded }));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: state.auth }));
vi.mock("./session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: { getMany: state.placements },
  }),
}));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let temp: string;
let project: string;
let cfg: OpenClawConfig;
let entry: {
  sessionId: string;
  spawnedCwd?: string;
  sessionRoot?: string;
  permissionMode?: "full" | "workspace";
  execNode?: string;
  repositoryWorkspaceId?: string;
  incognito?: boolean;
  visibility?: "draft" | "shared";
};
const sessionKey = "agent:main:dashboard:media";

beforeEach(async () => {
  state.placements.mockReset().mockReturnValue(new Map());
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assistant-image-policy-")));
  project = path.join(temp, "project");
  await fs.mkdir(project);
  cfg = {
    agents: { entries: { main: { workspace: path.join(temp, "agent") } } },
    tools: { fs: { workspaceOnly: true } },
  };
  entry = {
    sessionId: "session-one",
    spawnedCwd: project,
    sessionRoot: project,
    permissionMode: "workspace",
  };
  state.loaded.mockImplementation((requestedKey: string) => ({
    cfg,
    agentId: "main",
    canonicalKey: requestedKey,
    entry,
  }));
  state.auth.mockResolvedValue({
    authMethod: "token",
    operatorScopes: ["operator.admin", "operator.read"],
  });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(temp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function request(
  source: string,
  options: {
    ticket?: string;
    allow?: boolean;
    bytes?: boolean;
    sessionKey?: string;
    agentId?: string;
    unscoped?: boolean;
    method?: "GET" | "POST";
    omitAgent?: boolean;
  } = {},
) {
  const query = new URLSearchParams({ source });
  if (!options.unscoped) {
    query.set("sessionKey", options.sessionKey ?? sessionKey);
  }
  if (!options.omitAgent) {
    query.set("agentId", options.agentId ?? "main");
  }
  if (!options.bytes) {
    query.set("meta", "1");
  }
  if (options.ticket) {
    query.set("mediaTicket", options.ticket);
  }
  if (options.allow) {
    query.set("allow", "1");
  }
  const response = makeMockHttpResponse();
  const chunks: Buffer[] = [];
  response.res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = finished(response.res);
  await handleControlUiAssistantMediaRequest(
    {
      url: `/__openclaw__/assistant-media?${query}`,
      method: options.method ?? (options.allow ? "POST" : "GET"),
      headers: {},
      headersDistinct: {},
    } as IncomingMessage,
    response.res,
    { config: cfg, agentId: "main" },
  );
  await completed;
  const bytes = Buffer.concat(chunks);
  const body = bytes.toString("utf8");
  return {
    ...response,
    body,
    bytes,
    payload: body.startsWith("{") ? (JSON.parse(body) as Record<string, unknown>) : null,
  };
}

// The real HTTP boundary plus real files protect session-root admission and exact-file grants;
// existing media tests cover static agent roots only.
describe("assistant image session policy", () => {
  it("previews a protected project's image outside the agent workspace", async () => {
    const source = path.join(project, "image.png");
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({
      available: true,
      mimeType: "image/png",
      mediaTicket: expect.any(String),
    });
  });

  it("lets full sessions preview an outside image but not text disguised as an image", async () => {
    entry.permissionMode = "full";
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({ available: true });
    await fs.writeFile(source, "private text");
    expect((await request(source)).payload).toMatchObject({ available: false });
  });

  it("uses configured protection when there is no explicit session mode", async () => {
    delete entry.permissionMode;
    cfg.tools = { fs: { workspaceOnly: false } };
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({ available: true });
    cfg.tools.fs!.workspaceOnly = true;
    expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it("offers an explicit exact-image grant and renews it without granting siblings", async () => {
    const source = path.join(temp, "outside.png");
    const sibling = path.join(temp, "sibling.png");
    await fs.writeFile(source, PNG);
    await fs.writeFile(sibling, PNG);
    expect((await request(source)).payload).toMatchObject({
      available: false,
      code: "outside-allowed-folders",
      canAllow: true,
      retryable: false,
    });
    const allowed = (await request(source, { allow: true })).payload!;
    expect(allowed).toMatchObject({ available: true, mediaTicket: expect.any(String) });
    const ticket = String(allowed.mediaTicket);
    expect((await request(source, { ticket })).payload).toMatchObject({ available: true });
    expect((await request(sibling, { ticket })).payload).toMatchObject({ available: false });
    const bytes = await request(source, { ticket, bytes: true });
    expect(bytes.res.statusCode).toBe(200);
    expect(bytes.bytes).toEqual(PNG);
    expect(bytes.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  });

  it("does not let a reader grant outside access or renew an administrator's allowance", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    const allowed = (await request(source, { allow: true })).payload!;
    state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
    expect((await request(source)).payload).not.toHaveProperty("canAllow", true);
    expect((await request(source, { allow: true })).res.statusCode).toBe(403);
    expect((await request(source, { ticket: String(allowed.mediaTicket) })).payload).toMatchObject({
      available: false,
    });
  });

  it("rejects a replaced file and a replaced session when replaying an exact-image ticket", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    const ticket = String((await request(source, { allow: true })).payload!.mediaTicket);
    await fs.rename(source, `${source}.old`);
    await fs.writeFile(source, PNG);
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
    expect((await request(source, { ticket })).payload).toMatchObject({
      available: false,
      canAllow: true,
    });
    await fs.rm(source);
    await fs.rename(`${source}.old`, source);
    entry.sessionId = "replacement";
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  });

  it("does not grant an outside text file or a symlink escape under a protected project", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, "not an image");
    expect((await request(source, { allow: true })).payload).toMatchObject({ available: false });
    await fs.writeFile(source, PNG);
    const link = path.join(project, "link.png");
    await fs.symlink(source, link);
    expect((await request(link)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it.each(["execNode", "repositoryWorkspaceId"] as const)(
    "does not interpret %s session paths as Gateway-local image paths",
    async (owner) => {
      entry[owner] = "remote-workspace";
      const source = path.join(project, "image.png");
      await fs.writeFile(source, PNG);
      expect((await request(source)).payload).toMatchObject({
        available: false,
        code: "blocked-local-file",
      });
    },
  );
  it("keeps repository Full Access and Allow from exposing the configured Gateway workspace", async () => {
    entry.permissionMode = "full";
    const source = path.join(temp, "agent", "unrelated.png");
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, PNG);
    const ticket = String((await request(source)).payload!.mediaTicket);
    entry.repositoryWorkspaceId = "repository-workspace";
    delete entry.spawnedCwd;
    delete entry.sessionRoot;
    for (const options of [{}, { allow: true }]) {
      const denied = (await request(source, options)).payload;
      expect(denied).toMatchObject({ available: false, code: "blocked-local-file" });
      expect(denied).not.toHaveProperty("canAllow", true);
    }
    expect((await request(source, { bytes: true, ticket })).res.statusCode).toBe(404);
  });
  it("keeps protected project images separate from the unrelated configured agent workspace", async () => {
    const source = path.join(temp, "agent", "unrelated.png");
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it("rechecks full-to-workspace changes for existing byte tickets and metadata renewal", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    entry.permissionMode = "full";
    const ticket = String((await request(source)).payload!.mediaTicket);
    entry.permissionMode = "workspace";
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
    expect((await request(source, { ticket })).payload).toMatchObject({
      available: false,
      canAllow: true,
    });
  });

  it.each(["full", "workspace"] as const)(
    "keeps mutable %s-policy images readable after atomic replacement",
    async (mode) => {
      entry.permissionMode = mode;
      const source = path.join(mode === "full" ? temp : project, "replace.png");
      await fs.writeFile(source, PNG);
      const ticket = String((await request(source)).payload!.mediaTicket);
      await fs.rename(source, `${source}.old`);
      await fs.writeFile(source, PNG);
      const served = await request(source, { ticket, bytes: true });
      expect(served.res.statusCode).toBe(200);
      expect(served.bytes).toEqual(PNG);
    },
  );

  it.each(["full", "workspace"] as const)(
    "recognizes real outside SVG images in %s mode",
    async (mode) => {
      entry.permissionMode = mode;
      const source = path.join(temp, "diagram.svg");
      await fs.writeFile(
        source,
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      );
      const result = await request(source, { allow: mode === "workspace" });
      expect(result.payload).toMatchObject({ available: true, mimeType: "image/svg+xml" });
      const bytes = await request(source, {
        ticket: String(result.payload!.mediaTicket),
        bytes: true,
      });
      expect(bytes.res.statusCode).toBe(200);
      expect(bytes.bytes).toEqual(await fs.readFile(source));
      expect(bytes.setHeader).toHaveBeenCalledWith(
        "content-security-policy",
        expect.stringContaining("sandbox"),
      );
    },
  );

  it("denies incognito images to a named profile while preserving administrator access", async () => {
    const source = path.join(project, "private.png");
    await fs.writeFile(source, PNG);
    entry.incognito = true;
    state.auth.mockResolvedValue({
      authMethod: "trusted-proxy",
      operatorScopes: ["operator.read"],
      authenticatedUserProfile: {
        profileId: "reader",
        displayName: null,
        hasAvatar: false,
        updatedAt: 0,
      },
    });
    expect((await request(source)).res.statusCode).toBe(404);
    state.auth.mockResolvedValue({ authMethod: "token", operatorScopes: ["operator.admin"] });
    expect((await request(source)).payload).toMatchObject({ available: true });
  });

  it.each([
    { cap: "none", visibility: "shared", available: false },
    { cap: "view", visibility: "draft", available: false },
    { cap: "view", visibility: "shared", available: true },
  ] as const)(
    "applies the $cap role to $visibility session images",
    async ({ cap, visibility, available }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: cap }, agents: "*", scopes: ["operator.read"] },
            },
          },
        };
        const profile = ensureProfileForEmail("media-role-reader@example.test");
        const source = path.join(project, "image.png");
        await fs.writeFile(source, PNG);
        entry.visibility = visibility;
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          ...resolveHttpProfile(profile.id, profile.updatedAt, cfg),
        });
        const result = await request(source);
        if (available) {
          expect(result.payload).toMatchObject({ available: true });
        } else {
          expect(result.res.statusCode).toBe(404);
        }
      });
    },
  );
  it("keeps unscoped readers on the default static roots even when a query selects a full-access agent", async () => {
    cfg.tools = { fs: { workspaceOnly: false } };
    cfg.agents!.entries!.other = { workspace: project };
    const source = path.join(project, "private.png");
    await fs.writeFile(source, PNG);
    state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
    expect((await request(source, { unscoped: true, agentId: "other" })).payload).toMatchObject({
      available: false,
    });
    expect((await request(source, { unscoped: true, allow: true })).res.statusCode).toBe(403);
  });

  it("selects the scoped session's agent when its optional agent parameter is omitted", async () => {
    cfg.agents!.entries!.other = { workspace: project };
    state.loaded.mockImplementation((requestedKey: string) => ({
      cfg,
      agentId: "other",
      canonicalKey: requestedKey,
      entry,
    }));
    const source = path.join(project, "image.png");
    await fs.writeFile(source, PNG);
    expect(
      (await request(source, { sessionKey: "agent:other:dashboard:media", omitAgent: true }))
        .payload,
    ).toMatchObject({ available: true });
  });

  it("does not accept GET consent or move an allowed image ticket to another session", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    expect((await request(source, { allow: true, method: "GET" })).payload).toMatchObject({
      available: false,
    });
    const ticket = String((await request(source, { allow: true })).payload!.mediaTicket);
    expect(
      (await request(source, { ticket, bytes: true, sessionKey: `${sessionKey}-other` })).res
        .statusCode,
    ).toBe(404);
    expect((await request(source, { ticket, bytes: true, unscoped: true })).res.statusCode).toBe(
      404,
    );
  });

  it.each(["execNode", "repositoryWorkspaceId"] as const)(
    "keeps Gateway-owned inbound images available in a %s session",
    async (owner) => {
      entry[owner] = "remote-workspace";
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "state") }, async () => {
        const id = "remote-session-upload.png";
        const source = `media://inbound/${id}`;
        const file = path.join(resolveStateDir(), "media", "inbound", id);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, PNG);
        const metadata = await request(source);
        expect(metadata.payload).toMatchObject({ available: true });
        const served = await request(source, {
          ticket: String(metadata.payload!.mediaTicket),
          bytes: true,
        });
        expect(served.res.statusCode).toBe(200);
        expect(served.bytes).toEqual(PNG);
      });
    },
  );
  it.each(["visibility", "role assignment", "role definition"] as const)(
    "revalidates a named reader's saved media ticket after %s withdrawal",
    async (change) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
              denied: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        };
        const profile = ensureProfileForEmail("media-reader@example.test");
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          ...resolveHttpProfile(profile.id, profile.updatedAt, cfg),
        });
        const source = path.join(project, "shared.png");
        await fs.writeFile(source, PNG);
        const metadata = await request(source);
        expect(metadata.payload).toMatchObject({ available: true });
        const ticket = String(metadata.payload!.mediaTicket);
        // Ordinary mutations elsewhere must not revoke a still-authorized reader's ticket.
        invalidateSessionSharingSnapshot("agent:main:unrelated");
        expect((await request(source, { ticket, bytes: true })).bytes).toEqual(PNG);
        if (change === "visibility") {
          entry.visibility = "draft";
          invalidateSessionSharingSnapshot(sessionKey);
        } else if (change === "role assignment") {
          setUserProfileRole(profile.id, "denied");
          invalidateOperatorRolePolicy(profile.id);
        } else {
          cfg.gateway!.roles!.definitions.viewer = {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read"],
          };
        }
        await fs.rename(source, `${source}.old`);
        await fs.writeFile(source, PNG);
        const denied = await request(source, { ticket, bytes: true });
        expect(denied.res.statusCode).toBe(404);
        expect(denied.bytes).not.toEqual(PNG);
      });
    },
  );

  it.each(["metadata", "bytes"] as const)(
    "revalidates named reader access after asynchronous %s file preparation",
    async (operation) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        };
        const profile = ensureProfileForEmail("yielding-media-reader@example.test");
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          ...resolveHttpProfile(profile.id, profile.updatedAt, cfg),
        });
        const source = path.join(project, "shared.png");
        await fs.writeFile(source, PNG);
        const ticket = String((await request(source)).payload!.mediaTicket);
        const openFile = fs.open;
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const file = await openFile(filePath, flags, mode);
          if (filePath === source) {
            entry.visibility = "draft";
            invalidateSessionSharingSnapshot(sessionKey);
          }
          return file;
        });
        try {
          const denied = await request(source, { ticket, bytes: operation === "bytes" });
          expect(denied.res.statusCode).toBe(404);
          expect(denied.bytes).not.toEqual(PNG);
        } finally {
          openSpy.mockRestore();
        }
      });
    },
  );

  it.each(["metadata", "bytes"] as const)(
    "withdraws Gateway-local media after cloud dispatch during %s preparation",
    async (operation) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "placement-state") }, async () => {
        const { createWorkerSessionPlacementStore } =
          await import("./worker-environments/placement-store.js");
        const placements = createWorkerSessionPlacementStore();
        state.placements.mockImplementation((sessionIds: readonly string[]) =>
          placements.getMany(sessionIds),
        );
        entry.permissionMode = "full";
        const source = path.join(temp, "gateway-only.png");
        await fs.writeFile(source, PNG);
        const ticket = String((await request(source)).payload!.mediaTicket);
        const openFile = fs.open;
        let dispatched = false;
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const file = await openFile(filePath, flags, mode);
          if (filePath === source && !dispatched) {
            dispatched = true;
            let placement = placements.startDispatch({
              sessionId: entry.sessionId,
              sessionKey,
              agentId: "main",
              executionMode: "worker-turn",
            });
            for (const [to, patch] of [
              ["provisioning", { environmentId: "media-worker" }],
              ["syncing", { workerBundleHash: "a".repeat(64) }],
              [
                "starting",
                {
                  workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
                  remoteWorkspaceDir: "/remote/workspace",
                },
              ],
              ["active", { activeOwnerEpoch: 1 }],
            ] as const) {
              placement = placements.transition({
                sessionId: entry.sessionId,
                from: placement.state,
                to,
                expectedGeneration: placement.generation,
                patch,
              });
            }
          }
          return file;
        });
        try {
          const denied = await request(source, { ticket, bytes: operation === "bytes" });
          expect(dispatched).toBe(true);
          expect(entry.execNode).toBeUndefined();
          expect(denied.res.statusCode).toBe(404);
          expect(denied.bytes).not.toEqual(PNG);
        } finally {
          openSpy.mockRestore();
        }
      });
    },
  );

  it.each([
    { name: "report.pdf", content: "%PDF-1.7\nexisting report\n", mime: "application/pdf" },
    { name: "voice.wav", content: "existing audio bytes", mime: "audio/wav" },
    { name: "clip.mp4", content: "existing video bytes", mime: "video/mp4" },
  ])(
    "preserves legacy Full Access $name attachments under the configured agent workspace",
    async ({ name, content, mime }) => {
      entry.permissionMode = "full";
      const source = path.join(temp, "agent", name);
      await fs.mkdir(path.dirname(source));
      await fs.writeFile(source, content);
      const served = await request(source, { bytes: true });
      expect(served.res.statusCode).toBe(200);
      expect(served.bytes).toEqual(Buffer.from(content));
      expect(served.setHeader).toHaveBeenCalledWith("Content-Type", mime);
      const outside = path.join(temp, name);
      await fs.writeFile(outside, content);
      expect((await request(outside, { bytes: true })).res.statusCode).toBe(404);
    },
  );
});
