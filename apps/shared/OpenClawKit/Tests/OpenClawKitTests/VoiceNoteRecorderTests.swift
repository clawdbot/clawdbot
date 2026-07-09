import Foundation
import XCTest
@testable import OpenClawChatUI

@MainActor
private final class FakeVoiceNoteAudioCapture: VoiceNoteAudioCapture {
    var permissionGranted = true
    var duration: TimeInterval = 12.5
    var startError: Error?
    var startCount = 0
    var cancelCount = 0
    var activeURL: URL?
    var onStart: (() -> Void)?
    var failureHandler: (@MainActor () -> Void)?

    func requestPermission() async -> Bool {
        self.permissionGranted
    }

    func start(url: URL) throws {
        self.onStart?()
        if let startError { throw startError }
        self.startCount += 1
        self.activeURL = url
        try Data("voice-note".utf8).write(to: url)
    }

    func stop() -> TimeInterval {
        self.duration
    }

    func cancel() {
        self.cancelCount += 1
    }

    func setFailureHandler(_ handler: @escaping @MainActor () -> Void) {
        self.failureHandler = handler
    }

    var meterLevel: Double?

    func currentLevel() -> Double? {
        self.meterLevel
    }

    func failCapture() {
        self.failureHandler?()
    }
}

final class VoiceNoteRecorderTests: XCTestCase {
    @MainActor
    func testStartAndFinishProduceRecordingWithDuration() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        var activeChanges: [Bool] = []
        recorder.onRecordingActiveChanged = { activeChanges.append($0) }
        capture.onStart = { XCTAssertEqual(activeChanges, [true]) }

        let started = await recorder.start()
        XCTAssertTrue(started)
        guard case .recording = recorder.state else {
            return XCTFail("Expected recording state")
        }

        let result = try XCTUnwrap(recorder.finish())
        XCTAssertEqual(result.durationSeconds, 12.5)
        XCTAssertEqual(recorder.state, .finished(recording: result))
        XCTAssertEqual(recorder.completedRecording, result)
        XCTAssertEqual(activeChanges, [true, false])
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.fileURL.path))
        try FileManager.default.removeItem(at: result.fileURL)
    }

    @MainActor
    func testCompletedRecordingHasOneStagingOwner() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)

        let started = await recorder.start()
        XCTAssertTrue(started)
        let recording = try XCTUnwrap(recorder.finish())

        XCTAssertEqual(recorder.claimCompletedRecording(), recording)
        XCTAssertNil(recorder.claimCompletedRecording())
        XCTAssertTrue(recorder.ownsPendingChatAttachment)

        recorder.completeStaging(recording)

        XCTAssertEqual(recorder.state, .idle)
        XCTAssertFalse(recorder.ownsPendingChatAttachment)
        try FileManager.default.removeItem(at: recording.fileURL)
    }

    @MainActor
    func testCancelReturnsToIdleAndDeletesTemporaryFile() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)

        let started = await recorder.start()
        XCTAssertTrue(started)
        let fileURL = try XCTUnwrap(capture.activeURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))

        recorder.cancel()

        XCTAssertEqual(recorder.state, .idle)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertEqual(capture.cancelCount, 1)
    }

    @MainActor
    func testSuccessiveRecordingsUseUniqueTemporaryFiles() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(
            capture: capture,
            now: { Date(timeIntervalSince1970: 0) })

        let firstStarted = await recorder.start()
        XCTAssertTrue(firstStarted)
        let firstURL = try XCTUnwrap(capture.activeURL)
        recorder.cancel()

        let secondStarted = await recorder.start()
        XCTAssertTrue(secondStarted)
        let secondURL = try XCTUnwrap(capture.activeURL)
        XCTAssertNotEqual(firstURL, secondURL)
        recorder.cancel()
    }

    @MainActor
    func testDurationCapAutoFinishes() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        capture.duration = 0.25
        let recorder = OpenClawVoiceNoteRecorder(
            capture: capture,
            durationLimit: 0,
            timerIntervalNanoseconds: 1_000_000)

        let started = await recorder.start()
        XCTAssertTrue(started)
        try await waitUntil("voice note auto-finished") {
            await MainActor.run { recorder.completedRecording != nil }
        }

        let result = try XCTUnwrap(recorder.completedRecording)
        XCTAssertEqual(result.durationSeconds, 0.25)
        XCTAssertEqual(recorder.state, .finished(recording: result))
        try FileManager.default.removeItem(at: result.fileURL)
    }

    @MainActor
    func testPermissionDeniedBecomesUserVisibleFailure() async {
        let capture = FakeVoiceNoteAudioCapture()
        capture.permissionGranted = false
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)

        let started = await recorder.start()
        XCTAssertFalse(started)
        guard case let .failed(message) = recorder.state else {
            return XCTFail("Expected failure state")
        }
        XCTAssertTrue(message.contains("Microphone access"))
        XCTAssertEqual(capture.startCount, 0)
    }

    @MainActor
    func testCaptureStartFailureReleasesRecordingActivity() async {
        let capture = FakeVoiceNoteAudioCapture()
        capture.startError = NSError(domain: "VoiceNoteRecorderTests", code: 1)
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        var activeChanges: [Bool] = []
        recorder.onRecordingActiveChanged = { activeChanges.append($0) }

        let started = await recorder.start()

        XCTAssertFalse(started)
        XCTAssertEqual(activeChanges, [true, false])
        guard case .failed = recorder.state else {
            return XCTFail("Expected failure state")
        }
    }

    @MainActor
    func testCaptureInterruptionFailsAndDeletesTemporaryFile() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        var activeChanges: [Bool] = []
        recorder.onRecordingActiveChanged = { activeChanges.append($0) }

        let started = await recorder.start()
        XCTAssertTrue(started)
        let fileURL = try XCTUnwrap(capture.activeURL)

        capture.failCapture()

        XCTAssertEqual(activeChanges, [true, false])
        XCTAssertEqual(capture.cancelCount, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        guard case let .failed(message) = recorder.state else {
            return XCTFail("Expected failure state")
        }
        XCTAssertTrue(message.contains("interrupted"))
    }

    @MainActor
    func testStartIsRefusedWhileAlreadyRecording() async {
        let capture = FakeVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)

        let firstStart = await recorder.start()
        let secondStart = await recorder.start()
        XCTAssertTrue(firstStart)
        XCTAssertFalse(secondStart)
        XCTAssertEqual(capture.startCount, 1)
        recorder.cancel()
    }

    func testDurationLabelBoundsMalformedHistoryValues() {
        XCTAssertEqual(openClawVoiceNoteDurationLabel(.infinity), "0:00")
        XCTAssertEqual(openClawVoiceNoteDurationLabel(.nan), "0:00")
        XCTAssertEqual(openClawVoiceNoteDurationLabel(1e100), "3:00")
        XCTAssertEqual(openClawVoiceNoteDurationLabel(-1), "0:00")
    }

    @MainActor
    func testRecordingPublishesCaptureLevelsAndResetsOnFinish() async throws {
        let capture = FakeVoiceNoteAudioCapture()
        capture.meterLevel = 0.8
        let recorder = OpenClawVoiceNoteRecorder(
            capture: capture,
            timerIntervalNanoseconds: 2_000_000)

        let started = await recorder.start()
        XCTAssertTrue(started)
        XCTAssertEqual(recorder.level, 0)

        for _ in 0..<200 where recorder.level == 0 {
            try await Task.sleep(nanoseconds: 3_000_000)
        }
        XCTAssertGreaterThan(recorder.level, 0)

        _ = try XCTUnwrap(recorder.finish())
        XCTAssertEqual(recorder.level, 0)
    }

    @MainActor
    func testRecordButtonRequiresAttachmentInput() {
        let recorder = OpenClawVoiceNoteRecorder(capture: FakeVoiceNoteAudioCapture())
        let control = OpenClawChatVoiceNoteControl(recorder: recorder, isTalkActive: false)
        let button = OpenClawVoiceNoteButton(
            control: control,
            compact: false,
            isComposerEnabled: true,
            isAttachmentInputEnabled: false)

        XCTAssertFalse(button.isRecordingEnabled)
    }
}
