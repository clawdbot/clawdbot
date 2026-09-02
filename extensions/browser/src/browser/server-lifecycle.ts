import type { BrowserServerState } from "./server-context.js";
/** Browser server lifecycle helpers for parallel profile shutdown. */
import { beginProfileTransition } from "./server-context.lifecycle.js";

/** Invalidate every profile before awaiting any cleanup, then drain in parallel. */
export async function stopKnownBrowserProfiles(params: {
  current: BrowserServerState;
  closeSharedAdapters: boolean;
  onWarn: (message: string) => void;
}) {
  const drains = [...params.current.profiles.values()].map((runtime) =>
    beginProfileTransition({
      state: params.current,
      runtime,
      reason: "Browser runtime shutdown",
      closeSharedAdapters: params.closeSharedAdapters,
    }),
  );
  const settled = await Promise.allSettled(drains);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    params.onWarn(`openclaw browser stop failed: ${String(failed.reason)}`);
    throw failed.reason;
  }
}
