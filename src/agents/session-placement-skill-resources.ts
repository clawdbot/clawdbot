import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SkillSnapshot } from "../skills/types.js";

type ResourceContext = {
  source: SkillSnapshot;
  snapshot: SkillSnapshot;
  mounts: Array<{ hostPath: string; containerPath: string }>;
  assertCurrent: () => void;
};
const resources = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionSkillResources"),
  () => new AsyncLocalStorage<ResourceContext>(),
);

export function withSessionSkillResources<T>(
  context: ResourceContext,
  run: () => Promise<T>,
): Promise<T> {
  return resources.run(context, run);
}
export function resolveSessionSkillResourceSnapshot(
  source?: SkillSnapshot,
): SkillSnapshot | undefined {
  const context = resources.getStore();
  if (!context) {
    return source;
  }
  context.assertCurrent();
  if (source !== context.source && source !== context.snapshot) {
    throw new Error("Skill resources belong to a different prepared turn.");
  }
  return context.snapshot;
}
export function resolveSessionSkillResourceMounts(): ResourceContext["mounts"] | undefined {
  const context = resources.getStore();
  context?.assertCurrent();
  return context?.mounts;
}
