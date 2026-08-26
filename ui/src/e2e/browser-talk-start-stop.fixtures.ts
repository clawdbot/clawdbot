import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

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

export function videoTalkCatalog(activeProvider: "google" | "openai") {
  return {
    realtime: {
      activeProvider,
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
    const track = { stop: () => (state.tracksStopped += 1) };
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
          return { getTracks: () => [track] };
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
