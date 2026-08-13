import {
  GatewayClient,
  type GatewayClientCloseInfo,
  type GatewayClientOptions,
  type GatewayClientRequestOptions,
  type GatewayReconnectPausedInfo,
} from "../gateway/client.js";
import type { NodeHostGatewayConfig } from "./config.js";

type GatewayCandidateEvent = Parameters<NonNullable<GatewayClientOptions["onEvent"]>>[0];
type GatewayCandidateHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

type CandidateConnectionOptions = Omit<
  GatewayClientOptions,
  | "url"
  | "tlsFingerprint"
  | "onEvent"
  | "onHelloOk"
  | "onConnectError"
  | "onReconnectPaused"
  | "onClose"
>;

type GatewayCandidateConnectionParams = {
  candidates: readonly NodeHostGatewayConfig[];
  clientOptions: CandidateConnectionOptions;
  onEvent: (event: GatewayCandidateEvent) => void;
  onHelloOk: (hello: GatewayCandidateHello, url: string, tlsFingerprint?: string) => void;
  onConnectError: (error: Error) => void;
  onReconnectPaused: (info: GatewayReconnectPausedInfo) => void;
  onClose: (code: number, reason: string, info?: GatewayClientCloseInfo) => void;
  onWinningCandidate: (candidate: NodeHostGatewayConfig) => void;
};

function formatGatewayCandidateUrl(gateway: NodeHostGatewayConfig): string {
  const host = gateway.host ?? "127.0.0.1";
  const urlHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const contextPath = gateway.contextPath
    ? gateway.contextPath.startsWith("/")
      ? gateway.contextPath
      : `/${gateway.contextPath}`
    : "";
  return `${scheme}://${urlHost}:${port}${contextPath}`;
}

function canTryNextGatewayCandidate(info: GatewayClientCloseInfo | undefined): boolean {
  return info?.phase === "pre-hello" && info.connectRequestSent === false;
}

export function createNodeHostGatewayCandidateConnection(params: GatewayCandidateConnectionParams) {
  if (params.candidates.length === 0) {
    throw new Error("node host gateway candidate list cannot be empty");
  }

  let currentCandidateIndex = 0;
  let stopped = false;
  let winnerSelected = params.candidates.length === 1;
  let latestManifest: { caps: string[]; commands: string[] } | undefined;
  let currentClient = createCandidateClient(currentCandidateIndex);

  function createCandidateClient(candidateIndex: number): GatewayClient {
    const candidate = params.candidates[candidateIndex];
    if (!candidate) {
      throw new Error(`node host gateway candidate ${candidateIndex} is unavailable`);
    }
    const url = formatGatewayCandidateUrl(candidate);
    const candidateClient = new GatewayClient({
      ...params.clientOptions,
      url,
      tlsFingerprint: candidate.tlsFingerprint,
      onEvent: (event) => {
        if (currentCandidateIndex === candidateIndex) {
          params.onEvent(event);
        }
      },
      onHelloOk: (hello) => {
        if (currentCandidateIndex !== candidateIndex) {
          return;
        }
        if (!winnerSelected) {
          winnerSelected = true;
          params.onWinningCandidate(candidate);
        }
        params.onHelloOk(hello, url, candidate.tlsFingerprint);
      },
      onConnectError: (error) => {
        if (currentCandidateIndex === candidateIndex) {
          params.onConnectError(error);
        }
      },
      onReconnectPaused: (info) => {
        if (currentCandidateIndex === candidateIndex) {
          params.onReconnectPaused(info);
        }
      },
      onClose: (code, reason, info) => {
        if (currentCandidateIndex !== candidateIndex) {
          return;
        }
        params.onClose(code, reason, info);
        const nextCandidateIndex = candidateIndex + 1;
        if (
          stopped ||
          // A successful hello redeems setup credentials and promotes this
          // endpoint. Its own reconnect path owns durable device auth from here.
          winnerSelected ||
          nextCandidateIndex >= params.candidates.length ||
          !canTryNextGatewayCandidate(info)
        ) {
          return;
        }
        currentCandidateIndex = nextCandidateIndex;
        candidateClient.stop();
        queueMicrotask(() => {
          if (stopped || currentCandidateIndex !== nextCandidateIndex) {
            return;
          }
          currentClient = createCandidateClient(nextCandidateIndex);
          currentClient.start();
        });
      },
    });
    if (latestManifest) {
      candidateClient.updateNodeManifest(latestManifest);
    }
    return candidateClient;
  }

  return {
    start(): void {
      currentClient.start();
    },
    stop(): void {
      stopped = true;
      currentClient.stop();
    },
    request<T = Record<string, unknown>>(
      ...requestArgs: [method: string, params?: unknown, options?: GatewayClientRequestOptions]
    ): Promise<T> {
      return currentClient.request<T>(...requestArgs);
    },
    updateNodeManifest(manifest: { caps: string[]; commands: string[] }): void {
      // Availability may change before the first hello. Every later candidate
      // must start with the newest manifest rather than the constructor snapshot.
      latestManifest = manifest;
      currentClient.updateNodeManifest(manifest);
    },
  };
}
