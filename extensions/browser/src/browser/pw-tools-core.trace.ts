import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_TRACE_DIR } from "./paths.js";
import { ensureContextState, getPageForTargetId } from "./pw-session.js";

export async function traceStartViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const context = page.context();
  const ctxState = ensureContextState(context);
  if (ctxState.traceActive) {
    throw new Error("Trace already running. Stop the current trace before starting a new one.");
  }
  await context.tracing.start({
    screenshots: opts.screenshots ?? true,
    snapshots: opts.snapshots ?? true,
    sources: opts.sources ?? false,
  });
  ctxState.traceActive = true;
}

export async function traceStopViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const context = page.context();
  const ctxState = ensureContextState(context);
  if (!ctxState.traceActive) {
    throw new Error("No active trace. Start a trace before stopping it.");
  }
  await writeViaSiblingTempPath({
    rootDir: DEFAULT_TRACE_DIR,
    targetPath: opts.path,
    writeTemp: async (tempPath) => {
      await context.tracing.stop({ path: tempPath });
    },
  });
  ctxState.traceActive = false;
}
