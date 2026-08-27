import AVFAudio
import Foundation
import OpenClawKit

private func makeRealtimeAudioTapBlock(
    inputSampleRate: Double,
    targetSampleRate: Double,
    onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void) -> AVAudioNodeTapBlock
{
    { buffer, _ in
        // Core Audio invokes this on its realtime queue; the relay owns the hop
        // back to MainActor and never exposes AVAudioBuffer across that boundary.
        let encoded = RealtimeTalkPCM16Encoder.encode(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !encoded.isEmpty else { return }
        onAudio(RealtimeTalkAudioFrame(
            data: encoded,
            timestampMs: (ProcessInfo.processInfo.systemUptime * 1000).rounded(),
            rms: Float(TalkAudioLevel.rms(buffer: buffer))))
    }
}

@MainActor
final class IOSRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    private static let bufferSize: AVAudioFrameCount = 2048
    private let audioEngine = AVAudioEngine()

    var suppressesInputDuringOutput: Bool {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        // Built-in speaker output can bleed into the mic even in voiceChat mode.
        // Headsets retain full-duplex barge-in.
        return outputs.contains { $0.portType == .builtInSpeaker }
    }

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure _: @escaping @MainActor (String) -> Void) throws
    {
        self.stop()
        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "RealtimeTalkRelay", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Invalid realtime audio input format",
            ])
        }
        input.installTap(
            onBus: 0,
            bufferSize: Self.bufferSize,
            format: format,
            block: makeRealtimeAudioTapBlock(
                inputSampleRate: format.sampleRate,
                targetSampleRate: targetSampleRate,
                onAudio: onAudio))
        self.audioEngine.prepare()
        try self.audioEngine.start()
    }

    func stop() {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
    }
}

extension RealtimeTalkRelayTransport {
    static func ios(gateway: GatewayNodeSession, route: GatewayNodeSessionRoute) -> Self {
        Self(
            subscribeServerEvents: { bufferingNewest in
                await gateway.subscribeServerEvents(bufferingNewest: bufferingNewest)
            },
            request: { method, params, timeoutMs in
                let response = try await gateway.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentRoute: route)
                guard await gateway.currentRoute() == route else { throw CancellationError() }
                return response
            },
            isCurrent: { await gateway.currentRoute() == route })
    }
}
