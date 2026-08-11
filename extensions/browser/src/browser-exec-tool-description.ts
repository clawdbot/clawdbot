/** Build guidance for the agent-side Browser script tool. */
export function describeBrowserExecTool(): string {
  return [
    "Run JavaScript agent-side against the live browser session when work needs 3+ dependent browser steps, a loop, aggregation, or a conditional.",
    "Available async helpers only: act(action), snapshot(opts?), open(url), tabs(), and log(...values). act accepts one browser act action: click, type, press, hover, scrollIntoView, drag, select, fill, resize, wait, evaluate, close, or clickCoords; batch is unavailable because the script is the batch.",
    'Example: const page = await snapshot({ mode: "efficient" }); const rows = Object.entries(page.refs ?? {}).filter(([, v]) => v.role === "row"); const out = []; for (const [ref] of rows) { await act({ kind: "click", ref }); out.push((await act({ kind: "evaluate", fn: "() => document.title" })).result); } return out;',
    "Use the browser tool primitives for one-shot actions. Scripts run outside the page; only act:evaluate executes page-side JavaScript.",
    "On failure, follow the returned next step. Re-snapshot before retrying a stale ref; shorten the script or raise timeoutMs after a timeout.",
  ].join(" ");
}
