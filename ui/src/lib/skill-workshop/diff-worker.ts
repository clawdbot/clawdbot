import type { SkillWorkshopDiffRequest, SkillWorkshopDiffResponse } from "./diff.ts";

type PendingComparison = {
  resolve: (diff: SkillWorkshopDiffResponse["diff"]) => void;
  reject: (error: Error) => void;
};

let active: { worker: Worker; pending: Map<number, PendingComparison> } | undefined;
let nextId = 0;

export function compareSkillWorkshopInstructions(previous: string, current: string) {
  if (!active) {
    const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
    const pending = new Map<number, PendingComparison>();
    active = { worker, pending };
    // Inventory reads share one worker. The last reply releases it; row owners
    // still fence publication if an agent, source, or inventory changed.
    worker.addEventListener("message", ({ data }: MessageEvent<SkillWorkshopDiffResponse>) => {
      if (active?.worker !== worker) {
        return;
      }
      const comparison = pending.get(data.id)!;
      pending.delete(data.id);
      if (pending.size === 0) {
        worker.terminate();
        active = undefined;
      }
      comparison.resolve(data.diff);
    });
    worker.addEventListener("error", (event) => {
      if (active?.worker !== worker) {
        return;
      }
      worker.terminate();
      active = undefined;
      for (const comparison of pending.values()) {
        comparison.reject(new Error(event.message));
      }
      pending.clear();
    });
  }
  const owner = active;
  return new Promise<SkillWorkshopDiffResponse["diff"]>((resolve, reject) => {
    const id = nextId++;
    owner.pending.set(id, { resolve, reject });
    owner.worker.postMessage({ id, previous, current } satisfies SkillWorkshopDiffRequest, []);
  });
}
