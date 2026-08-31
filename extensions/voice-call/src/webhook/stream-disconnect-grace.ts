// Voice Call plugin module owns reconnect grace for carrier media streams.

const STREAM_DISCONNECT_GRACE_MS = 2_000;

export type StreamDisconnectLifecycle = {
  connect: (providerCallId: string, streamId: string) => void;
  disconnect: (providerCallId: string, streamId: string) => void;
  retire: (providerCallId: string, streamId: string) => void;
};

type StreamState = {
  streamId: string;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

/** Track the current carrier stream and expire disconnected calls after reconnect grace. */
export class StreamDisconnectGrace implements StreamDisconnectLifecycle {
  private readonly streams = new Map<string, StreamState>();

  constructor(
    private readonly onGraceExpired: (stream: { providerCallId: string; streamId: string }) => void,
  ) {}

  connect(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (current?.disconnectTimer) {
      clearTimeout(current.disconnectTimer);
    }
    this.streams.set(providerCallId, { streamId });
  }

  disconnect(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (!current || current.streamId !== streamId || current.disconnectTimer) {
      return;
    }

    const disconnectTimer = setTimeout(() => {
      const latest = this.streams.get(providerCallId);
      if (latest?.disconnectTimer !== disconnectTimer) {
        return;
      }
      this.streams.delete(providerCallId);
      this.onGraceExpired({ providerCallId, streamId });
    }, STREAM_DISCONNECT_GRACE_MS);
    disconnectTimer.unref?.();
    current.disconnectTimer = disconnectTimer;
  }

  retire(providerCallId: string, streamId: string): void {
    const current = this.streams.get(providerCallId);
    if (!current || current.streamId !== streamId) {
      return;
    }
    if (current.disconnectTimer) {
      clearTimeout(current.disconnectTimer);
    }
    this.streams.delete(providerCallId);
  }

  close(): void {
    for (const state of this.streams.values()) {
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
      }
    }
    this.streams.clear();
  }
}
