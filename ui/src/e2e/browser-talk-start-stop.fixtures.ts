import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

export async function dispatchOpenAiTalkEvent(page: Page, event: unknown) {
  await page.evaluate((payload) => {
    const channel = (
      window as Window & { openclawVideoTalkE2e?: { peer: { channel: EventTarget } } }
    ).openclawVideoTalkE2e?.peer.channel;
    if (!channel) {
      throw new Error("Expected the browser Talk data channel");
    }
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }, event);
}

export type WebRtcSdpE2eProof = {
  bodyCancelCount: number;
  bodyCancelResolvedCount: number;
  fetchCount: number;
  remoteDescriptionCount: number;
  statuses: number[];
};

type WebRtcSdpResponseFixture = {
  body: string;
  status: number;
};

export type MicrophoneLossE2eProof = {
  tracksStopped: number;
  peerClosed: boolean;
  trackState: MediaStreamTrackState | null;
  stage: string;
  localConnection: RTCPeerConnectionState | null;
  localIce: RTCIceConnectionState | null;
  remoteIce: RTCIceConnectionState;
  remoteGathering: RTCIceGatheringState;
  endMicrophone: () => void;
};

export async function installMicrophoneLossWebRtcFixture(page: Page) {
  await page.addInitScript(() => {
    const NativePeerConnection = RTCPeerConnection;
    const remote = new NativePeerConnection();
    let localConnection = (): RTCPeerConnectionState | null => null;
    let localIce = (): RTCIceConnectionState | null => null;
    let microphone: MediaStreamTrack | undefined;
    const proof: MicrophoneLossE2eProof = {
      tracksStopped: 0,
      peerClosed: false,
      stage: "idle",
      get localConnection() {
        return localConnection();
      },
      get localIce() {
        return localIce();
      },
      get remoteIce() {
        return remote.iceConnectionState;
      },
      get remoteGathering() {
        return remote.iceGatheringState;
      },
      get trackState() {
        return microphone?.readyState ?? null;
      },
      // Browser fault injection: exercise the native track event boundary,
      // without claiming a physical microphone removal or permission revocation.
      endMicrophone: () => microphone?.dispatchEvent(new Event("ended")),
    };
    Object.defineProperty(window, "openclawMicrophoneLossE2e", { value: proof });
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      proof.stage = "microphone-requested";
      const stream = await getUserMedia(constraints);
      proof.stage = "microphone-acquired";
      microphone = stream.getAudioTracks()[0];
      if (microphone) {
        const stop = microphone.stop.bind(microphone);
        microphone.stop = () => {
          proof.tracksStopped += 1;
          stop();
        };
      }
      return stream;
    };
    class ObservedPeerConnection extends NativePeerConnection {
      constructor() {
        super();
        localConnection = () => this.connectionState;
        localIce = () => this.iceConnectionState;
      }
      override close() {
        proof.peerClosed = true;
        remote.close();
        super.close();
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { value: ObservedPeerConnection });
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.openai.com/v1/realtime/calls") {
        return fetch(input, init);
      }
      if (typeof init?.body !== "string") {
        throw new Error("Missing local WebRTC SDP offer");
      }
      proof.stage = "offer-received";
      await remote.setRemoteDescription({ type: "offer", sdp: init.body });
      proof.stage = "offer-applied";
      await remote.setLocalDescription(await remote.createAnswer());
      proof.stage = "answer-gathering";
      if (remote.iceGatheringState !== "complete") {
        await new Promise<void>((resolve) => {
          const gathered = () => {
            if (remote.iceGatheringState === "complete") {
              remote.removeEventListener("icegatheringstatechange", gathered);
              resolve();
            }
          };
          remote.addEventListener("icegatheringstatechange", gathered);
        });
      }
      proof.stage = "answer-ready";
      return new Response(remote.localDescription?.sdp, {
        headers: { "Content-Type": "application/sdp" },
      });
    };
  });
}

export function videoTalkCatalog(activeProvider: "google" | "openai") {
  return {
    realtime: {
      activeProvider,
      ready: true,
      providers: [{ id: activeProvider, label: activeProvider, supportsVideoFrames: true }],
    },
  };
}

export async function installTalkBrowserFixtures(page: Page) {
  await page.addInitScript(() => {
    type InputProcessor = {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null;
    };
    const state = {
      audioContextsClosed: 0,
      tracksStopped: 0,
      constraints: [] as unknown[],
      inputProcessor: null as InputProcessor | null,
      meterLevel: 0,
    };
    const track = Object.assign(new EventTarget(), { stop: () => (state.tracksStopped += 1) });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "built-in", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "usb", label: "USB Audio Interface" },
          { kind: "videoinput", deviceId: "camera", label: "Camera" },
        ],
        getUserMedia: async (constraints: unknown) => {
          state.constraints.push(constraints);
          return {
            getAudioTracks: () => [track],
            getTracks: () => [track],
          };
        },
      },
    });

    class MockAudioContext {
      readonly currentTime = 0;
      readonly destination = {};
      readonly sampleRate: number;

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        state.inputProcessor = processor;
        return processor;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect() {},
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(state.meterLevel);
          },
        };
      }

      async close() {
        state.audioContextsClosed += 1;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(window, "openclawTalkE2eState", {
      configurable: true,
      value: state,
    });
  });
}

async function installWebRtcSdpResponseFixture(page: Page, fixture: WebRtcSdpResponseFixture) {
  await page.addInitScript(() => {
    const proofWindow = window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof };
    const microphoneTrack = Object.assign(new EventTarget(), { stop() {} });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getAudioTracks: () => [microphoneTrack],
          getTracks: () => [microphoneTrack],
        }),
      },
    });
    proofWindow.openclawWebRtcSdpE2e = {
      bodyCancelCount: 0,
      bodyCancelResolvedCount: 0,
      fetchCount: 0,
      remoteDescriptionCount: 0,
      statuses: [],
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.openai.com/v1/realtime/calls")) {
        return response;
      }
      const proof = proofWindow.openclawWebRtcSdpE2e;
      if (!proof || !response.body) {
        return response;
      }
      proof.fetchCount += 1;
      proof.statuses.push(response.status);
      const originalCancel = response.body.cancel.bind(response.body);
      response.body.cancel = async (reason) => {
        proof.bodyCancelCount += 1;
        try {
          return await originalCancel(reason);
        } finally {
          proof.bodyCancelResolvedCount += 1;
        }
      };
      return response;
    };

    class FakeDataChannel extends EventTarget {
      readyState = "open";
      send() {}
      close() {
        this.readyState = "closed";
      }
    }

    class FakePeerConnection extends EventTarget {
      connectionState = "new";
      sctp = { maxMessageSize: 256 * 1024 };
      channel = new FakeDataChannel();
      addTrack() {}
      createDataChannel() {
        return this.channel;
      }
      async createOffer() {
        return { type: "offer" as const, sdp: "offer-sdp" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        const proof = proofWindow.openclawWebRtcSdpE2e;
        if (proof) {
          proof.remoteDescriptionCount += 1;
        }
      }
      close() {
        this.connectionState = "closed";
      }
    }

    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: FakePeerConnection,
    });
  });
  await page.route("https://api.openai.com/v1/realtime/calls", async (route) => {
    await route.fulfill({
      status: fixture.status,
      contentType: "application/sdp",
      body: fixture.body,
    });
  });
}

export async function installWebRtcSdpFailureFixture(page: Page) {
  await installWebRtcSdpResponseFixture(page, {
    status: 502,
    body: "provider failure",
  });
}

export async function installOversizedWebRtcSdpFixture(page: Page) {
  await installWebRtcSdpResponseFixture(page, {
    status: 200,
    body: "x".repeat(256 * 1024 + 1),
  });
}

export async function captureComposerProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "voice-controls");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator(".agent-chat__composer-shell")
    .screenshot({ path: path.join(artifactDir, fileName) });
}

export async function captureMicrophoneLossProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "voice-controls");
  await mkdir(artifactDir, { recursive: true });
  // The error floats above the composer bounds; retain the real chat context.
  await page.screenshot({ path: path.join(artifactDir, fileName), fullPage: true });
}

export async function captureVideoTalkProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "video-talk");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator(".agent-chat__composer-shell")
    .screenshot({ path: path.join(artifactDir, fileName) });
}

export async function captureWebRtcSdpAlertProof(page: Page, fileName: string) {
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "webrtc-sdp");
  await mkdir(artifactDir, { recursive: true });
  await page
    .locator('.agent-chat__talk-status[role="alert"]')
    .screenshot({ path: path.join(artifactDir, fileName) });
}

export async function installBlockedMicrophoneFixture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
}

export async function installBlockedVideoTalkFixture(page: Page) {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          if (constraints.video) {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          return getUserMedia(constraints);
        },
      },
    });
    class FakePeerConnection extends EventTarget {
      connectionState = "new";
      close() {
        this.connectionState = "closed";
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: FakePeerConnection,
    });
  });
}
