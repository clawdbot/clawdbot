export function shouldAlsoListenOnLoopback(host: string | undefined) {
  const h = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!h) return false; // default listen() already includes loopback
  if (h === "0.0.0.0" || h === "::") return false; // already includes loopback
  if (h === "localhost") return false;
  if (h === "127.0.0.1" || h.startsWith("127.")) return false;
  if (h === "::1") return false;
  return true;
}
