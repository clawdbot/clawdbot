import { computeSkillWorkshopDiff, type SkillWorkshopDiffRequest } from "./diff.ts";

globalThis.addEventListener("message", ({ data }: MessageEvent<SkillWorkshopDiffRequest>) => {
  globalThis.postMessage(
    {
      id: data.id,
      diff: computeSkillWorkshopDiff(data.previous, data.current),
    },
    { transfer: [] },
  );
});
