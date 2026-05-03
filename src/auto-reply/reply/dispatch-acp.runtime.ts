import { createLazyImportLoader } from "../../shared/lazy-promise.js";

type ShouldBypassAcpDispatchForCommand =
  (typeof import("./dispatch-acp-command-bypass.js"))["shouldBypassAcpDispatchForCommand"];
type TryDispatchAcpReply = (typeof import("./dispatch-acp.js"))["tryDispatchAcpReply"];

const dispatchAcpLoader = createLazyImportLoader(() => import("./dispatch-acp.js"));
const dispatchAcpCommandBypassLoader = createLazyImportLoader(
  () => import("./dispatch-acp-command-bypass.js"),
);

function loadDispatchAcp() {
  return dispatchAcpLoader.load();
}

function loadDispatchAcpCommandBypass() {
  return dispatchAcpCommandBypassLoader.load();
}

export async function shouldBypassAcpDispatchForCommand(
  ...args: Parameters<ShouldBypassAcpDispatchForCommand>
): Promise<Awaited<ReturnType<ShouldBypassAcpDispatchForCommand>>> {
  const mod = await loadDispatchAcpCommandBypass();
  return mod.shouldBypassAcpDispatchForCommand(...args);
}

export async function tryDispatchAcpReply(
  ...args: Parameters<TryDispatchAcpReply>
): Promise<Awaited<ReturnType<TryDispatchAcpReply>>> {
  const mod = await loadDispatchAcp();
  return await mod.tryDispatchAcpReply(...args);
}
