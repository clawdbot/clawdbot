import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import type { MediaFact } from "../../media/media-facts.js";
import { saveMediaBuffer } from "../../media/store.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  cleanupWorkerTurnLauncherTest,
  root,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";

describe.each(["local", "repository"] as const)("%s workspace media policy", (kind) => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  async function fixture(workspaceOnly: boolean) {
    const gatewayWorkspace = path.join(root, "gateway-agent-workspace");
    const localWorkspace = path.join(root, "session-workspace");
    await Promise.all([fs.mkdir(gatewayWorkspace), fs.mkdir(localWorkspace)]);
    const workspace: WorkerSessionWorkspace =
      kind === "local"
        ? { kind, path: localWorkspace }
        : {
            kind,
            repository: getSessionRepositoryWorkspaceStore().create({
              agentId: sessionTarget.agentId,
              sessionKey: sessionTarget.sessionKey,
              url: "https://github.com/example/repository.git",
              assertCurrent: () => {},
            }),
          };
    const staged: Buffer[] = [];
    const stageAttachments = vi.fn<NonNullable<WorkerTunnelHandle["stageAttachments"]>>(
      async (request) => {
        expect(request.isAuthorized()).toBe(true);
        for (const name of await fs.readdir(request.localPath, { recursive: true })) {
          const source = path.join(request.localPath, name);
          if (path.basename(name) !== ".gitignore" && (await fs.stat(source)).isFile()) {
            staged.push(await fs.readFile(source));
          }
        }
      },
    );
    const tunnel: WorkerTunnelHandle = {
      environmentId: "media-policy-environment",
      ownerEpoch: 1,
      stageAttachments,
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      quiesceWorkspace: vi.fn(),
      runWorkspaceCommand: vi.fn(),
      stop: vi.fn(),
    };
    const input = turn("media-policy");
    const prepare = async (media: MediaFact[]) =>
      await prepareWorkerTurnMedia({
        turn: {
          ...input,
          prompt: "Inspect the attached files",
          media,
          config: {
            tools: { fs: { workspaceOnly } },
            agents: { defaults: { workspace: gatewayWorkspace } },
          },
        },
        workspace,
        // A matching Gateway directory must not turn remote cwd metadata into an allowlist.
        remoteWorkspaceDir: gatewayWorkspace,
        history: [],
        tunnel,
        signal: new AbortController().signal,
        isAuthorized: () => true,
      });
    return { gatewayWorkspace, localWorkspace, stageAttachments, staged, prepare };
  }

  it.each([
    { workspaceOnly: true, contentType: "image/png", name: "image.png" },
    { workspaceOnly: true, contentType: "text/plain", name: "document.txt" },
    { workspaceOnly: false, contentType: "image/png", name: "image.png" },
    { workspaceOnly: false, contentType: "text/plain", name: "document.txt" },
  ])(
    "applies workspaceOnly=$workspaceOnly to Gateway $contentType sources",
    async ({ workspaceOnly, contentType, name }) => {
      const f = await fixture(workspaceOnly);
      const data =
        contentType === "image/png"
          ? createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 })
          : Buffer.from("Gateway agent file outside this session workspace");
      const source = path.join(f.gatewayWorkspace, name);
      await fs.writeFile(source, data);
      const preparation = f.prepare([{ path: source, contentType }]);
      if (workspaceOnly) {
        await expect(preparation).rejects.toThrow(
          contentType === "image/png" ? "could not load 1 image" : "not under an allowed directory",
        );
        expect(f.stageAttachments).not.toHaveBeenCalled();
      } else {
        await preparation;
        expect(f.staged).toEqual([data]);
      }
    },
  );

  it("keeps managed originals readable under workspace-only policy", async () => {
    const f = await fixture(true);
    const image = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const document = Buffer.from("Managed incoming document");
    const savedImage = await saveMediaBuffer(image, "image/png", "inbound");
    const savedDocument = await saveMediaBuffer(document, "text/plain", "inbound");
    const media: MediaFact[] = [
      { url: `media://inbound/${savedImage.id}`, contentType: "image/png" },
      { path: savedDocument.path, contentType: "text/plain" },
    ];
    const expected = [image, document];
    if (kind === "local") {
      const local = Buffer.from("Owned local session file");
      const source = path.join(f.localWorkspace, "owned.txt");
      await fs.writeFile(source, local);
      media.push({ path: source, contentType: "text/plain" });
      expected.push(local);
    }
    const prepared = await f.prepare(media);
    expect(prepared.images).toHaveLength(1);
    expect(f.stageAttachments).toHaveBeenCalledOnce();
    expect(f.staged).toHaveLength(expected.length);
    expect(f.staged).toEqual(expect.arrayContaining(expected));
  });
});
