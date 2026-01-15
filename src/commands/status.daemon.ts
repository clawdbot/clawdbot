import { resolveGatewayService } from "../daemon/service.js";
import { formatDaemonRuntimeShort } from "./status.format.js";

export async function getDaemonStatusSummary(): Promise<{
  label: string;
  installed: boolean | null;
  loadedText: string;
  runtimeShort: string | null;
}> {
  try {
    const service = resolveGatewayService();
    const [loaded, runtime, command] = await Promise.all([
      service.isLoaded({ env: process.env }).catch(() => false),
      service.readRuntime(process.env).catch(() => undefined),
      service.readCommand(process.env).catch(() => null),
    ]);
    const installed = command != null;
    const loadedText = loaded ? service.loadedText : service.notLoadedText;
    const runtimeShort = formatDaemonRuntimeShort(runtime);
    return { label: service.label, installed, loadedText, runtimeShort };
  } catch {
    return {
      label: "Daemon",
      installed: null,
      loadedText: "unknown",
      runtimeShort: null,
    };
  }
}
