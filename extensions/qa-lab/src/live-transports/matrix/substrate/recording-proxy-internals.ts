function normalizeMatrixIdSegment(segment: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  if (decoded.startsWith("!")) {
    return "{roomId}";
  }
  if (decoded.startsWith("@")) {
    return "{userId}";
  }
  if (decoded.startsWith("$")) {
    return "{eventId}";
  }
  if (decoded.startsWith("#")) {
    return "{roomAlias}";
  }
  return segment;
}

export function normalizeMatrixQaRoute(pathname: string) {
  const segments = pathname.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const beforePrevious = segments[index - 2];
    if (previous === "rooms") {
      segments[index] = "{roomId}";
      continue;
    }
    if (previous === "profile" || previous === "user") {
      segments[index] = "{userId}";
      continue;
    }
    if (previous === "filter") {
      segments[index] = "{filterId}";
      continue;
    }
    if (previous === "join") {
      segments[index] = normalizeMatrixIdSegment(segments[index] ?? "");
      continue;
    }
    if (previous === "devices") {
      segments[index] = "{deviceId}";
      continue;
    }
    if (previous === "redact") {
      segments[index] = "{eventId}";
      continue;
    }
    if (beforePrevious === "send" || beforePrevious === "redact") {
      segments[index] = "{transactionId}";
      continue;
    }
    if (beforePrevious === "sendToDevice") {
      segments[index] = "{transactionId}";
      continue;
    }
    if (previous === "version" && beforePrevious === "room_keys") {
      segments[index] = "{backupVersion}";
      continue;
    }
    if (previous === "keys" && beforePrevious === "room_keys") {
      segments[index] = "{roomId}";
      continue;
    }
    if (segments[index - 2] === "keys" && segments[index - 3] === "room_keys") {
      segments[index] = "{sessionId}";
      continue;
    }
    if (segments[index - 2] === "state" && segments[index] !== "") {
      segments[index] = "{stateKey}";
      continue;
    }
    if (previous === "account_data" && segments[index]?.startsWith("m.secret_storage.key.")) {
      segments[index] = "m.secret_storage.key.{keyId}";
      continue;
    }
    const mediaActionIndex = segments.findIndex(
      (segment) => segment === "download" || segment === "thumbnail",
    );
    if (mediaActionIndex >= 0 && index === mediaActionIndex + 2) {
      segments[index] = "{mediaId}";
      segments[index - 1] = "{serverName}";
      continue;
    }
    if (mediaActionIndex >= 0 && index === mediaActionIndex + 3) {
      segments[index] = "{filename}";
      continue;
    }
    segments[index] = normalizeMatrixIdSegment(segments[index] ?? "");
  }
  return segments.join("/");
}
