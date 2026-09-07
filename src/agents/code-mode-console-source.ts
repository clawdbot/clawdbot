/** Console is guest-only diagnostic text, not a host logging capability. */
export const CODE_MODE_CONSOLE_SOURCE = String.raw`
  // The counter lives in the VM snapshot. JSON code units are a conservative
  // bound (at most three UTF-8 bytes each), including empty-message overhead.
  let consoleUnits = 0;
  const consoleLimit = 16_384;
  const consoleMarker = "[console output truncated]";
  function consoleWrite(level, args) {
    if (consoleUnits >= consoleLimit) return;
    let nodes = 100;
    const seen = new Set();
    const clip = (value, limit) => {
      if (value.length <= limit) return value;
      // Do not split a surrogate pair at a diagnostic boundary.
      let end = limit;
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      return value.slice(0, end) + "…[truncated]";
    };
    const inspect = (value, depth = 0) => {
      if (--nodes < 0) return "[truncated]";
      if (typeof value === "string") return clip(value, 512);
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "undefined") return "undefined";
      if (typeof value === "bigint") return clip(String(value), 512) + "n";
      if (typeof value === "symbol") return clip(String(value), 512);
      if (typeof value === "function") return "[Function]";
      if (seen.has(value)) return "[Circular]";
      if (depth >= 4) return "[truncated]";
      seen.add(value);
      try {
        if (value instanceof GuestPromise) return promiseOutput;
        const array = Array.isArray(value);
        const result = array ? [] : Object.create(null);
        let count = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (count++ >= 50 || nodes <= 0) {
            if (array) result.push("[truncated]");
            else result["…"] = "[truncated]";
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          const item = descriptor && "value" in descriptor
            ? inspect(descriptor.value, depth + 1) : "[Accessor]";
          if (array) result.push(item);
          else result[clip(key, 512)] = item;
        }
        if (value instanceof Error) {
          const message = Object.getOwnPropertyDescriptor(value, "message");
          result.message = message && "value" in message ? inspect(message.value, depth + 1) : "[Accessor]";
        }
        return result;
      } finally {
        seen.delete(value);
      }
    };
    let message = level === "log" ? "" : "[" + level + "] ";
    for (let i = 0; i < args.length; i++) {
      if (i > 0) message += " ";
      if (nodes <= 0 || message.length >= 4096) { message += "[truncated]"; break; }
      try {
        const value = inspect(args[i]);
        message += typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        message += "[Unserializable]";
      }
    }
    const entry = { type: "text", text: clip(message, 4096) };
    const units = JSON.stringify(entry).length;
    if (consoleUnits + units > consoleLimit - 100) {
      output.push({ type: "text", text: consoleMarker });
      consoleUnits = consoleLimit;
      return;
    }
    consoleUnits += units;
    output.push(entry);
  }
  const guestConsole = Object.freeze(Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => consoleWrite(level, args)]),
  ));
`;
