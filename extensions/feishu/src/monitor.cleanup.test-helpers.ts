import { botNames, botOpenIds, httpServers, wsClients } from "./monitor.state.js";

export function cleanupFeishuMonitorStateForTests(): void {
  for (const client of wsClients.values()) {
    try {
      client.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  wsClients.clear();

  for (const server of httpServers.values()) {
    try {
      server.closeAllConnections();
      server.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  httpServers.clear();
  botOpenIds.clear();
  botNames.clear();
}
