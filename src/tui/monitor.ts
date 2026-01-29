import { Container, Text, TUI, ProcessTerminal } from "@mariozechner/pi-tui";
import { scanStatus } from "../commands/status.scan.js";
import { theme } from "./theme/theme.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDuration } from "../commands/status.format.js";
import { resolveUpdateAvailability } from "../commands/status.update.js";

export async function runMonitorTui(runtime: RuntimeEnv, opts: { intervalMs: number }) {
  const tui = new TUI(new ProcessTerminal());
  const root = new Container();

  const header = new Text("", 1, 0);
  const statusLine = new Text("", 1, 0);
  const resourcesLine = new Text("", 1, 0);
  const agentsHeader = new Text(theme.header("Agents & Sessions"), 1, 0);
  const agentsText = new Text("", 10, 0); // Fixed height for now
  const footer = new Text("", 1, 0);

  root.addChild(header);
  root.addChild(statusLine);
  root.addChild(resourcesLine);
  root.addChild(new Text(" ", 1, 0)); // Spacer
  root.addChild(agentsHeader);
  root.addChild(agentsText);
  root.addChild(new Text(" ", 1, 0)); // Spacer
  root.addChild(footer);

  tui.addChild(root);

  let running = true;
  let lastUpdate = 0;

  const refresh = async () => {
    if (!running) return;
    try {
      const now = Date.now();
      const status = await scanStatus({ json: true, timeoutMs: opts.intervalMs - 200 }, runtime);

      const latency = status.gatewayProbe?.connectLatencyMs
        ? formatDuration(status.gatewayProbe.connectLatencyMs)
        : "N/A";

      const gatewayState = status.gatewayReachable
        ? theme.success("Online")
        : theme.error("Offline");

      const updateLatency = Date.now() - now;
      lastUpdate = now;

      const updates = resolveUpdateAvailability(status.update);
      const updateMsg = updates.available ? ` • ${theme.accent("UPDATE AVAILABLE")}` : "";

      header.setText(
        theme.header(`Moltbot Monitor • ${new Date().toLocaleTimeString()}${updateMsg}`),
      );

      statusLine.setText(
        `Gateway: ${gatewayState} • Latency: ${latency} • Ver: ${status.gatewaySelf?.version ?? "unknown"} • Mode: ${status.gatewayMode}`,
      );

      const mem = status.memory;
      const memStatus = mem ? `${mem.files} files, ${mem.chunks} chunks` : "Disabled/Unknown";
      resourcesLine.setText(`Memory: ${memStatus} • OS: ${status.osSummary.label}`);

      // Agents & Sessions
      const agents = status.agentStatus.agents;
      const sessions = status.summary.sessions.recent;

      let agentLines: string[] = [];
      if (agents.length === 0) {
        agentLines.push(theme.dim("No agents found."));
      } else {
        agentLines.push(`${agents.length} Agent(s) Active`);
      }

      if (sessions.length > 0) {
        agentLines.push("");
        agentLines.push("Recent Sessions:");
        for (const s of sessions.slice(0, 5)) {
          agentLines.push(`• ${s.key} (${s.model ?? "default"}) - ${formatDuration(s.age)} ago`);
        }
      } else {
        agentLines.push("");
        agentLines.push(theme.dim("No active sessions."));
      }

      agentsText.setText(agentLines.join("\n"));

      footer.setText(theme.dim(`Update took ${updateLatency}ms. Press Ctrl+C to exit.`));

      tui.requestRender();
    } catch (err) {
      footer.setText(theme.error(`Error: ${err}`));
    }

    if (running) {
      setTimeout(refresh, opts.intervalMs);
    }
  };

  tui.start();
  refresh();

  process.on("SIGINT", () => {
    running = false;
    tui.stop();
    process.exit(0);
  });
}
