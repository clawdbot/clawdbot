export function hasOperatorTransport({ records, status }) {
  const frames = records
    .filter(record => record.runId === status.runId && (record.event === "wire-in" || record.event === "wire-out"))
    .map(record => ({ ...record, frame: JSON.parse(record.raw) }));
  return status.connections.some(connection => {
    if (!connection.authenticated || !connection.open ||
        typeof connection.deviceId !== "string" || connection.deviceId.length === 0) return false;
    return frames.some(connect =>
      connect.connectionId === connection.id && connect.event === "wire-in" &&
      connect.frame.type === "req" && connect.frame.method === "connect" &&
      connect.frame.params?.client?.id === "openclaw-macos" &&
      connect.frame.params.client.mode === "ui" && connect.frame.params.role === "operator" &&
      connect.frame.params.device?.id === connection.deviceId &&
      frames.some(hello => hello.connectionId === connection.id && hello.event === "wire-out" &&
        hello.record > connect.record && hello.frame.type === "res" &&
        hello.frame.id === connect.frame.id && hello.frame.ok === true &&
        hello.frame.payload?.type === "hello-ok" &&
        hello.frame.payload.server?.connId === connection.id &&
        hello.frame.payload.auth?.role === "operator"),
    );
  });
}
