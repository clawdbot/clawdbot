import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { toInboundMediaFactsWithMetadata } from "../channels/inbound-event/media.js";
import { createManagedOutgoingMediaBlocks } from "../gateway/managed-image-attachments.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveLocalMediaPath } from "./local-media-path.js";
import { appendLocalMediaParentRoots } from "./local-roots.js";

const { probeMediaFilesWithinBudget } = vi.hoisted(() => ({
  probeMediaFilesWithinBudget: vi.fn(),
}));

vi.mock("./media-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-probe.js")>()),
  probeMediaFilesWithinBudget,
}));

function toSingleSlashUppercaseFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href.replace(/^file:\/\//u, "FILE:");
}

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-media-url-"));
  try {
    return await run(root);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe.runIf(process.platform === "win32")("Windows local media file URLs", () => {
  beforeEach(() => {
    probeMediaFilesWithinBudget.mockReset();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("resolves single-slash mixed-case file schemes and rejects unsafe file URLs", async () => {
    await withTempRoot(async (root) => {
      const sourcePath = path.join(root, "Media Folder Ω", "photo.png");

      expect(resolveLocalMediaPath(toSingleSlashUppercaseFileUrl(sourcePath))).toBe(sourcePath);
      expect(resolveLocalMediaPath("FILE://server/share/photo.png")).toBeUndefined();
      expect(resolveLocalMediaPath("FILE:///C:/Media%2Fphoto.png")).toBeUndefined();
    });
  });

  it("adds the exact parent root for a single-slash uppercase file URL", async () => {
    await withTempRoot(async (root) => {
      const sourcePath = path.join(root, "Media Folder Ω", "photo.png");

      expect(appendLocalMediaParentRoots([], [toSingleSlashUppercaseFileUrl(sourcePath)])).toEqual([
        path.dirname(sourcePath),
      ]);
    });
  });

  it("probes inbound metadata through a single-slash uppercase file URL", async () => {
    await withTempRoot(async (root) => {
      const sourcePath = path.join(root, "Media Folder Ω", "voice.mp3");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      probeMediaFilesWithinBudget.mockResolvedValueOnce([{ durationMs: 1250 }]);

      await expect(
        toInboundMediaFactsWithMetadata([
          { path: toSingleSlashUppercaseFileUrl(sourcePath), contentType: "audio/mpeg" },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({
          path: toSingleSlashUppercaseFileUrl(sourcePath),
          durationMs: 1250,
        }),
      ]);
      expect(probeMediaFilesWithinBudget).toHaveBeenCalledWith(
        [{ filePath: sourcePath, kind: "audio" }],
        { budgetMs: 3000, concurrency: 2, maxProbes: 8 },
      );
    });
  });

  it("ingests a single-slash uppercase file URL into managed outgoing media", async () => {
    await withTempRoot(async (root) => {
      const sourcePath = path.join(root, "workspace", "Media Folder Ω", "photo.png");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, createSolidPngBuffer(8, 8, { r: 24, g: 64, b: 128 }));
      const sourceUrl = new URL(toSingleSlashUppercaseFileUrl(sourcePath));
      sourceUrl.searchParams.set("sig", "secret");
      sourceUrl.hash = "preview";

      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const blocks = await createManagedOutgoingMediaBlocks({
          stateDir: root,
          sessionKey: "agent:main:main",
          items: [
            {
              url: sourceUrl.href.replace(/^file:/u, "FILE:"),
              trustedLocal: false,
            },
          ],
          localRoots: [path.join(root, "workspace")],
        });

        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ type: "image", alt: "photo.png" });
        expect(JSON.stringify(blocks[0])).not.toContain(sourcePath);
        expect(JSON.stringify(blocks[0])).not.toContain("sig=secret");
      });
    });
  });
});
