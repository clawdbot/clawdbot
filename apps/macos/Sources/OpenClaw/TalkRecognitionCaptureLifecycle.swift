import AudioToolbox
@preconcurrency import AVFoundation
import Foundation
import OpenClawKit
import OSLog
import Speech

struct PreparedRecognitionCapture {
    let request: SFSpeechAudioBufferRecognitionRequest
    let engine: AVAudioEngine
    let activeInputResolution: AudioInputDeviceResolution

    func start() throws {
        do {
            self.engine.prepare()
            try self.engine.start()
        } catch {
            self.discard()
            throw error
        }
    }

    func discard() {
        self.request.endAudio()
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
    }
}

enum TalkAudioInputError: LocalizedError {
    case unavailable
    case invalidFormat

    var errorDescription: String? {
        switch self {
        case .unavailable: "Selected input and system default are unavailable"
        case .invalidFormat: "Selected audio input has no usable format"
        }
    }
}

enum TalkRecognitionCaptureLifecycle {
    static func configure(_ request: SFSpeechAudioBufferRecognitionRequest) {
        SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)
    }

    static func start<Capture>(
        isCurrent: () -> Bool,
        prepare: (_ enableVoiceProcessing: Bool) throws -> Capture,
        discard: (Capture) -> Void,
        publish: (Capture) -> Void,
        onFailure: (_ enableVoiceProcessing: Bool, _ error: Error) -> Void) -> Bool
    {
        for enableVoiceProcessing in [true, false] {
            guard isCurrent() else { return false }
            do {
                let capture = try prepare(enableVoiceProcessing)
                guard isCurrent() else {
                    discard(capture)
                    return false
                }
                publish(capture)
                return true
            } catch {
                onFailure(enableVoiceProcessing, error)
            }
        }
        return false
    }

    static func prepareCapture(
        selection: AudioInputDeviceResolution,
        logger: Logger,
        onRMS: @escaping @Sendable (Double) -> Void,
        enableVoiceProcessing: Bool) throws -> PreparedRecognitionCapture
    {
        let request = SFSpeechAudioBufferRecognitionRequest()
        self.configure(request)
        let audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        var tapInstalled = false
        do {
            if enableVoiceProcessing {
                try input.setVoiceProcessingEnabled(true)
            }

            let activeResolution = self.bindSelectedInputIfNeeded(
                selection,
                to: input,
                logger: logger)
            guard activeResolution.resolvedUID != nil else {
                throw TalkAudioInputError.unavailable
            }

            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                throw TalkAudioInputError.invalidFormat
            }
            input.removeTap(onBus: 0)
            input.installTap(
                onBus: 0,
                bufferSize: 2048,
                format: format)
            { [weak request] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
                onRMS(TalkAudioLevel.rms(buffer: buffer))
            }
            tapInstalled = true
            return PreparedRecognitionCapture(
                request: request,
                engine: audioEngine,
                activeInputResolution: activeResolution)
        } catch {
            request.endAudio()
            if tapInstalled {
                input.removeTap(onBus: 0)
            }
            audioEngine.stop()
            throw error
        }
    }

    private static func bindSelectedInputIfNeeded(
        _ selection: AudioInputDeviceResolution,
        to input: AVAudioInputNode,
        logger: Logger) -> AudioInputDeviceResolution
    {
        guard selection.shouldBindSelectedDevice, let selectedUID = selection.resolvedUID else {
            return selection
        }
        guard let audioUnit = input.audioUnit,
              var deviceID = AudioInputDeviceObserver.inputDeviceID(forUID: selectedUID)
        else {
            logger.warning("talk selected input could not be resolved; using system default")
            return self.defaultFallback(for: selection)
        }

        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioObjectID>.size))
        guard status == noErr else {
            logger.warning("talk selected input binding failed status=\(status); using system default")
            return self.defaultFallback(for: selection)
        }
        logger.info("talk selected input bound uid=\(selectedUID, privacy: .private(mask: .hash))")
        return selection
    }

    private static func defaultFallback(
        for selection: AudioInputDeviceResolution) -> AudioInputDeviceResolution
    {
        AudioInputDeviceResolution(
            selectedUID: selection.selectedUID,
            resolvedUID: AudioInputDeviceObserver.resolveSelection(nil).resolvedUID,
            fellBackToSystemDefault: selection.selectedUID != nil)
    }
}
