import Foundation

@MainActor
public protocol StreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult
    func stop() -> Double?
}

@MainActor
public protocol PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult
    func stop() -> Double?
}

extension StreamingAudioPlayer: StreamingAudioPlaying {}
extension PCMStreamingAudioPlayer: PCMStreamingAudioPlaying {}
