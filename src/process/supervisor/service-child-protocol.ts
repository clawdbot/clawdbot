export type ServiceChildStart = {
  type: "start";
  generation: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  secretFd?: number;
  controlFd: number;
};

type ServiceChildControlMessage = {
  generation: string;
  sequence: number;
} & ({ type: "cancel"; signal: "SIGTERM" | "SIGKILL" } | { type: "startup-error-ack" });

type ServiceChildAnchorPayload =
  | {
      type: "ready";
      commandPid: number;
      anchorPid: number;
    }
  | {
      type: "root-result";
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: "closing";
      reason: "cancel" | "lineage-closed" | "lineage-lost" | "parent-lost";
    }
  | {
      type: "startup-error";
      error: string;
    };

export type ServiceChildAnchorMessage = ServiceChildAnchorPayload & {
  generation: string;
  sequence: number;
};

export type ServiceChildRelayMessage =
  | ServiceChildStart
  | { type: "anchor-exit"; generation: string; code: number | null; signal: NodeJS.Signals | null }
  | { type: "relay-error"; generation: string; error: string };

export function encodeServiceChildMessage(
  message: ServiceChildStart | ServiceChildControlMessage | ServiceChildAnchorMessage,
): string {
  return `${JSON.stringify(message)}\n`;
}
