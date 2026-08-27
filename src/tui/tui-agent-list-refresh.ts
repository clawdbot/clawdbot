import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { TuiAgentsList } from "./tui-backend.js";
import { formatTuiErrorMessage } from "./tui-formatters.js";

/** Refresh an authoritative agent roster without discarding the last good snapshot on failure. */
export async function refreshTuiAgentList(params: {
  load: () => Promise<TuiAgentsList>;
  apply: (result: TuiAgentsList) => void;
  reportError: (message: string) => void;
}): Promise<Result<void, string>> {
  try {
    params.apply(await params.load());
    return ok(undefined);
  } catch (error) {
    const message = formatTuiErrorMessage(error);
    params.reportError(message);
    return err(message);
  }
}
