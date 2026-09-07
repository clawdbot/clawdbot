export function correlatePublication({ records, receipt, connectionId, afterRecord, event, sessionKey, agentId }) {
  if (receipt.connectionId !== connectionId) {
    throw new Error("Publication receipt does not name the original socket");
  }
  const frames = records
    .filter(record => record.connectionId === connectionId && record.record > afterRecord &&
      (record.event === "wire-in" || record.event === "wire-out"))
    .map(record => ({ ...record, frame: JSON.parse(record.raw) }));
  const events = frames.filter(record => record.event === "wire-out" && record.frame.type === "event" &&
    record.frame.event === event && record.frame.seq === receipt.sequence);
  if (events.length === 0) return { state: "pending" };
  if (events.length !== 1) return { state: "ambiguous", reason: "Multiple records match the publication receipt" };
  const publication = events[0];
  const requests = frames.filter(record => record.record > publication.record && record.event === "wire-in" &&
    record.frame.type === "req" && record.frame.method === "chat.metadata" &&
    record.frame.params?.sessionKey === sessionKey && record.frame.params.agentId === agentId);
  if (requests.length === 0) return { state: "pending" };
  if (requests.length !== 1) return { state: "ambiguous", reason: "Multiple scoped reads follow this publication" };
  const request = requests[0];
  const responses = frames.filter(record => record.record > request.record && record.event === "wire-out" &&
    record.frame.type === "res" && record.frame.id === request.frame.id);
  if (responses.length === 0) return { state: "pending" };
  if (responses.length !== 1) return { state: "ambiguous", reason: "Multiple responses match the scoped read" };
  const response = responses[0];
  return {
    state: "correlated",
    connectionId,
    event,
    sequence: receipt.sequence,
    revision: receipt.revision,
    publicationRecord: publication.record,
    requestId: request.frame.id,
    requestRecord: request.record,
    responseRecord: response.record,
    response: response.frame,
  };
}
