import net from "node:net";
export function canConnectLocal() {
  return net.connect(443, "127.0.0.1");
}
export function unclassified() {
  return net.connect(443, "example.com");
}
