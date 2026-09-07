export function correlateQuickChatConnection({ records, status, afterRecord, sessionKey, agentId }) {
  const frames = records
    .filter(record => record.event === "wire-in" || record.event === "wire-out")
    .map(record => ({ ...record, frame: JSON.parse(record.raw) }));
  const candidates = [];
  for (const connection of status.connections.filter(item => item.authenticated && item.open)) {
    const connected = frames.filter(item => item.connectionId === connection.id);
    const hello = connected.find(item => item.event === "wire-in" && item.frame.method === "connect");
    if (!hello || hello.frame.params.client.id !== "openclaw-macos" ||
        hello.frame.params.client.mode !== "ui" || hello.frame.params.role !== "operator" ||
        hello.frame.params.device.id !== connection.deviceId) continue;
    const requests = connected.filter(item => item.event === "wire-in" && item.record > afterRecord);
    const metadata = requests.filter(item => item.frame.method === "chat.metadata" &&
      item.frame.params?.sessionKey === sessionKey && item.frame.params.agentId === agentId);
    if (metadata.length === 0) continue;
    const sessions = requests.filter(item => item.frame.method === "sessions.list" &&
      item.frame.params?.search === sessionKey && item.frame.params.agentId === agentId &&
      item.frame.params.limit === 200);
    const agents = requests.filter(item => item.frame.method === "agents.list");
    const paired = request => connected.find(item => item.event === "wire-out" &&
      item.record > request.record && item.frame.type === "res" && item.frame.id === request.frame.id &&
      item.frame.ok === true);
    const settled = group => group.find(request => paired(request));
    const triplet = [settled(metadata), settled(sessions), settled(agents)];
    candidates.push({
      connectionId: connection.id,
      deviceId: connection.deviceId,
      connectRecord: hello.record,
      client: hello.frame.params.client,
      complete: triplet.every(Boolean),
      requests: triplet.filter(Boolean).map(request => ({
        method: request.frame.method,
        requestId: request.frame.id,
        requestRecord: request.record,
        responseRecord: paired(request).record,
      })),
    });
  }
  if (candidates.length > 1) return { state: "ambiguous", candidates };
  if (candidates.length === 0 || !candidates[0].complete) return { state: "pending", candidates };
  return { state: "correlated", destination: candidates[0], candidates };
}
