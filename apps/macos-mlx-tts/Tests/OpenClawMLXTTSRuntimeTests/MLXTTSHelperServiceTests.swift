import Foundation
import OpenClawMLXTTSProtocol
import XCTest
@testable import OpenClawMLXTTSRuntime

final class MLXTTSHelperServiceTests: XCTestCase {
    func testReusesModelForMatchingRepoAndReloadsForChange() async {
        let state = TestState()
        let service = MLXTTSHelperService(
            loadModel: { repo in
                await state.loaded(repo)
                return TestModel(state: state)
            },
            eventSink: { event in await state.emitted(event) })

        await service.handle(.synthesize(request(id: "one", repo: "repo-a")))
        await service.waitUntilIdle()
        await service.handle(.synthesize(request(id: "two", repo: "repo-a")))
        await service.waitUntilIdle()
        await service.handle(.synthesize(request(id: "three", repo: "repo-b")))
        await service.waitUntilIdle()

        let loadedRepos = await state.loadedRepos
        let generatedTexts = await state.generatedTexts
        let events = await state.events
        XCTAssertEqual(loadedRepos, ["repo-a", "repo-b"])
        XCTAssertEqual(generatedTexts, ["hello", "hello", "hello"])
        XCTAssertEqual(events.count, 3)
    }

    func testRejectsConcurrentSynthesis() async {
        let state = TestState()
        let service = MLXTTSHelperService(
            loadModel: { _ in SlowTestModel() },
            eventSink: { event in await state.emitted(event) })

        await service.handle(.synthesize(request(id: "one", repo: "repo-a")))
        await service.handle(.synthesize(request(id: "two", repo: "repo-a")))
        _ = await service.handle(.shutdown)

        let events = await state.events
        XCTAssertTrue(events.contains(.error(MLXTTSErrorEvent(
            id: "two",
            code: .busy,
            message: "another synthesis is already in flight"))))
        XCTAssertTrue(events.contains(.canceled(id: "one")))
    }

    func testCancellationKeepsCachedModelAvailable() async {
        let state = TestState()
        let model = SlowTestModel()
        let service = MLXTTSHelperService(
            loadModel: { repo in
                await state.loaded(repo)
                return model
            },
            eventSink: { event in await state.emitted(event) })

        await service.handle(.synthesize(request(id: "one", repo: "repo-a")))
        await service.handle(.cancel(id: "one"))
        await service.waitUntilIdle()
        await service.handle(.synthesize(request(id: "two", repo: "repo-a")))
        await service.handle(.cancel(id: "two"))
        await service.waitUntilIdle()

        let loadedRepos = await state.loadedRepos
        let events = await state.events
        XCTAssertEqual(loadedRepos, ["repo-a"])
        XCTAssertEqual(events, [.canceled(id: "one"), .canceled(id: "two")])
    }

    func testConvertsSamplesToLittleEndianPCM16() {
        let pcm = MLXTTSHelperService.makePCM16(samples: [-1, 0, 1])
        XCTAssertEqual(pcm, Data([0x01, 0x80, 0x00, 0x00, 0xFF, 0x7F]))
    }

    func testStreamsPCMAndForwardsReferenceInputs() async {
        let state = TestState()
        let service = MLXTTSHelperService(
            loadModel: { _ in TestModel(state: state) },
            eventSink: { event in await state.emitted(event) })
        let streamRequest = MLXTTSRequest.synthesize(MLXTTSSynthesizeRequest(
            id: "stream",
            text: "hello",
            modelRepo: "repo-a",
            language: "en",
            voice: nil,
            referenceAudioPath: "/tmp/reference.wav",
            referenceText: "reference transcript",
            stream: true))

        await service.handle(streamRequest)
        await service.waitUntilIdle()

        let events = await state.events
        XCTAssertEqual(events, [
            .streamStarted(MLXTTSStreamStart(id: "stream", sampleRate: 32000)),
            .audioChunk(MLXTTSAudioChunk(
                id: "stream",
                pcm: Data([0x01, 0x80, 0x00, 0x00, 0xFF, 0x7F]))),
            .completed(id: "stream"),
        ])
        let references = await state.references
        XCTAssertEqual(references, ["/tmp/reference.wav|reference transcript"])
    }

    func testStreamDoesNotStartWhenGenerationProducesNoAudio() async {
        let state = TestState()
        let service = MLXTTSHelperService(
            loadModel: { _ in EmptyTestModel() },
            eventSink: { event in await state.emitted(event) })

        await service.handle(.synthesize(MLXTTSSynthesizeRequest(
            id: "empty",
            text: "hello",
            modelRepo: "repo-a",
            language: nil,
            voice: nil,
            stream: true)))
        await service.waitUntilIdle()

        let events = await state.events
        XCTAssertEqual(events.count, 1)
        guard case let .error(error) = events.first else {
            XCTFail("expected generation error")
            return
        }
        XCTAssertEqual(error.id, "empty")
        XCTAssertEqual(error.code, .generationFailed)
    }
}

private func request(id: String, repo: String) -> MLXTTSSynthesizeRequest {
    MLXTTSSynthesizeRequest(id: id, text: "hello", modelRepo: repo, language: nil, voice: nil)
}

private actor TestState {
    private(set) var loadedRepos: [String] = []
    private(set) var generatedTexts: [String] = []
    private(set) var events: [MLXTTSEvent] = []
    private(set) var references: [String] = []

    func loaded(_ repo: String) {
        self.loadedRepos.append(repo)
    }

    func generated(_ text: String) {
        self.generatedTexts.append(text)
    }

    func emitted(_ event: MLXTTSEvent) {
        self.events.append(event)
    }

    func referenced(path: String?, text: String?) {
        self.references.append("\(path ?? "nil")|\(text ?? "nil")")
    }
}

private final class TestModel: MLXTTSSpeechModel, @unchecked Sendable {
    let sampleRate = 32000
    let state: TestState

    init(state: TestState) {
        self.state = state
    }

    func generate(
        text: String,
        voice _: String?,
        language _: String?,
        referenceAudioPath: String?,
        referenceText: String?) async throws -> [Float]
    {
        await self.state.generated(text)
        await self.state.referenced(path: referenceAudioPath, text: referenceText)
        return [-1, 0, 1]
    }
}

private final class SlowTestModel: MLXTTSSpeechModel, @unchecked Sendable {
    let sampleRate = 32000

    func generate(
        text _: String,
        voice _: String?,
        language _: String?,
        referenceAudioPath _: String?,
        referenceText _: String?) async throws -> [Float]
    {
        try await Task.sleep(for: .seconds(30))
        return []
    }
}

private final class EmptyTestModel: MLXTTSSpeechModel, @unchecked Sendable {
    let sampleRate = 32000

    func generate(
        text _: String,
        voice _: String?,
        language _: String?,
        referenceAudioPath _: String?,
        referenceText _: String?) async throws -> [Float]
    {
        []
    }
}
