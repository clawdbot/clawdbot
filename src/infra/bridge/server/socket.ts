export function configureNodeBridgeSocket(socket: {
  setNoDelay: (noDelay?: boolean) => void;
  setKeepAlive: (enable?: boolean, initialDelay?: number) => void;
}) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15_000);
}
