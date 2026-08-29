import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as fsSafe from "../infra/fs-safe.js";
import { createApplyPatchTool } from "./apply-patch.js";

const rootControl = vi.hoisted((): { factory?: typeof fsSafe.root } => ({}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof fsSafe>();
  return {
    ...actual,
    root: (...args: Parameters<typeof fsSafe.root>) =>
      (rootControl.factory ?? actual.root)(...args),
  };
});

it("awaits one patch-owned root before completing a host no-op envelope", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "patch-root-lifetime-")));
  try {
    const filePath = path.join(dir, "note.txt");
    await fs.writeFile(filePath, "unchanged\n");
    const root = await fsSafe.root(dir);
    const initialization = createDeferred<fsSafe.Root>();
    const awaited = createDeferred();
    // Observe promise consumption without timing assumptions. Guarded host reads
    // remain real and can finish independently of this pending initialization.
    class RootInitialization extends Promise<fsSafe.Root> {}
    const pendingRoot = new RootInitialization((resolve, reject) => {
      void initialization.promise.then(resolve, reject);
    });
    const then = pendingRoot.then.bind(pendingRoot);
    vi.spyOn(pendingRoot, "then").mockImplementation((onfulfilled, onrejected) => {
      awaited.resolve();
      return then(onfulfilled, onrejected);
    });
    // A plain factory avoids Vitest consuming the returned promise to track
    // mock settlement before the patch owner can await it.
    let rootCalls = 0;
    rootControl.factory = () => {
      rootCalls += 1;
      return pendingRoot;
    };
    const execution = createApplyPatchTool({ cwd: dir }).execute(
      "no-op",
      {
        input: `*** Begin Patch
*** Update File: note.txt
@@
-unchanged
+unchanged
*** Update File: note.txt
@@
-unchanged
+unchanged
*** End Patch`,
      },
      undefined,
    );
    try {
      await expect(
        Promise.race([
          awaited.promise.then(() => "root awaited"),
          execution.then(() => "patch settled"),
        ]),
      ).resolves.toBe("root awaited");
      initialization.resolve(root);
      await expect(execution).resolves.toMatchObject({
        content: [{ type: "text", text: "No changes made to note.txt." }],
        details: { summary: { added: [], modified: [], deleted: [] } },
        terminate: true,
      });
      expect(rootCalls).toBe(1);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("unchanged\n");
    } finally {
      // Release and join even on the old-code assertion failure, before removing
      // the fixture. The regression must not create its own orphaned work.
      initialization.resolve(root);
      try {
        await execution;
      } finally {
        delete rootControl.factory;
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
