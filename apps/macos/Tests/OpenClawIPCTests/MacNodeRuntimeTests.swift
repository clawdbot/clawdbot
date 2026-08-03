import CoreLocation
import Dispatch
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    actor AsyncGate {
        private var isOpen = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            guard !self.isOpen else { return }
            await withCheckedContinuation { continuation in
                self.waiters.append(continuation)
            }
        }

        func open() {
            self.isOpen = true
            let waiters = self.waiters
            self.waiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }
    }

    private final class LockedCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func increment() {
            self.lock.lock()
            self.count += 1
            self.lock.unlock()
        }

        func value() -> Int {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.count
        }
    }

    private final class CatalogWorkerProbe: @unchecked Sendable {
        private let lock = NSLock()
        private let releaseFirst = DispatchSemaphore(value: 0)
        private var calls = 0
        private var active = 0
        private var peakActive = 0

        func run() -> String {
            self.lock.lock()
            self.calls += 1
            let call = self.calls
            self.active += 1
            self.peakActive = max(self.peakActive, self.active)
            self.lock.unlock()
            if call == 1 {
                self.releaseFirst.wait()
            }
            self.lock.lock()
            self.active -= 1
            self.lock.unlock()
            return "call-\(call)"
        }

        func release() {
            self.releaseFirst.signal()
        }

        func snapshot() -> (calls: Int, peakActive: Int) {
            self.lock.lock()
            defer { self.lock.unlock() }
            return (self.calls, self.peakActive)
        }
    }

    private func waitForCount(_ expected: Int, counter: LockedCounter) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while counter.value() < expected, clock.now < deadline {
            await Task.yield()
        }
        return counter.value() >= expected
    }

    actor CanvasRefreshProbe {
        private(set) var calls = 0

        func refresh() -> String? {
            self.calls += 1
            return "http://127.0.0.1:18789/__openclaw__/cap/refreshed-token"
        }
    }

    actor CanvasReconnectProbe {
        private var surfaceURL = "http://127.0.0.1:18789/__openclaw__/cap/old-token"

        func current() -> String? {
            self.surfaceURL
        }

        func reconnectDuringRefresh() -> String? {
            self.surfaceURL = "http://127.0.0.1:18789/__openclaw__/cap/new-token"
            return nil
        }
    }

    @MainActor
    final class ScreenSnapshotProbeServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
        var snapshotCallCount = 0
        var receivedSnapshotParams: MacNodeScreenSnapshotParams?
        var snapshotResult: ScreenSnapshotResult
        var snapshotError: Error?

        init(
            snapshotResult: ScreenSnapshotResult = ScreenSnapshotResult(
                data: Data("ok".utf8),
                format: .jpeg,
                width: 10,
                height: 10,
                displayFrameId: "display-frame-test"),
            snapshotError: Error? = nil)
        {
            self.snapshotResult = snapshotResult
            self.snapshotError = snapshotError
        }

        func snapshotScreen(
            screenIndex: Int?,
            maxWidth: Int?,
            quality: Double?,
            format: OpenClawScreenSnapshotFormat?) async throws -> ScreenSnapshotResult
        {
            self.snapshotCallCount += 1
            self.receivedSnapshotParams = MacNodeScreenSnapshotParams(
                screenIndex: screenIndex,
                maxWidth: maxWidth,
                quality: quality,
                format: format)
            if let snapshotError {
                throw snapshotError
            }
            return self.snapshotResult
        }

        func recordScreen(
            screenIndex _: Int?,
            durationMs _: Int?,
            fps _: Double?,
            includeAudio _: Bool?,
            outPath _: String?) async throws -> (path: String, hasAudio: Bool)
        {
            let url = FileManager().temporaryDirectory
                .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
            try Data("ok".utf8).write(to: url)
            return (path: url.path, hasAudio: false)
        }

        func locationAuthorizationStatus() -> CLAuthorizationStatus {
            .authorizedAlways
        }

        func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
            .fullAccuracy
        }

        func currentLocation(
            desiredAccuracy: OpenClawLocationAccuracy,
            maxAgeMs: Int?,
            timeoutMs: Int?) async throws -> CLLocation
        {
            _ = desiredAccuracy
            _ = maxAgeMs
            _ = timeoutMs
            return CLLocation(latitude: 0, longitude: 0)
        }

        func performComputerAct(
            _ params: OpenClawComputerActParams,
            lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
        {
            _ = params
            _ = lifecycleGeneration
            return OpenClawComputerActResult(ok: true, cursorX: 0, cursorY: 0)
        }

        func releaseHeldInput(lifecycleGeneration: UInt64) async {
            _ = lifecycleGeneration
        }
    }

    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `handle invoke returns injected Codex thread catalog`() async {
        let payload = #"{"sessions":[]}"#
        let runtime = MacNodeRuntime(
            codexThreadCatalogEnabled: { true },
            codexThreadListRequest: { paramsJSON in
                #expect(paramsJSON == #"{"limit":7}"#)
                return payload
            })
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-codex-threads",
            command: MacNodeCodexThreadCatalogContract.listCommand,
            paramsJSON: #"{"limit":7}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == payload)
    }

    @Test func `handle invoke enforces local Codex catalog consent`() async {
        let runtime = MacNodeRuntime(
            codexThreadCatalogEnabled: { false },
            codexThreadListRequest: { _ in
                Issue.record("disabled Codex catalog request must not execute")
                return #"{"sessions":[]}"#
            })
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-codex-disabled",
            command: MacNodeCodexThreadCatalogContract.listCommand))

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: Codex session catalog is disabled")
    }

    @Test func `handle invoke returns an injected Codex transcript turn page`() async {
        let payload = #"{"data":[{"id":"item-1","type":"agentMessage","text":"answer"}],"nextCursor":"page-2"}"#
        let runtime = MacNodeRuntime(
            codexThreadCatalogEnabled: { true },
            codexThreadTurnsRequest: { paramsJSON in
                #expect(paramsJSON == #"{"threadId":"thread-1","limit":50}"#)
                return payload
            })
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-codex-items",
            command: MacNodeCodexThreadCatalogContract.turnsCommand,
            paramsJSON: #"{"threadId":"thread-1","limit":50}"#))

        #expect(response.ok)
        #expect(response.payloadJSON == payload)
    }

    @Test func `handle invoke returns injected Claude session pages`() async {
        let listPayload = #"{"sessions":[]}"#
        let readPayload = #"{"threadId":"thread-1","items":[]}"#
        let runtime = MacNodeRuntime(
            claudeSessionCatalogEnabled: { true },
            claudeSessionListRequest: { paramsJSON in
                #expect(paramsJSON == #"{"limit":7}"#)
                return listPayload
            },
            claudeSessionReadRequest: { paramsJSON in
                #expect(paramsJSON == #"{"threadId":"thread-1","limit":20}"#)
                return readPayload
            })

        let list = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-claude-list",
            command: MacNodeClaudeSessionCatalogContract.listCommand,
            paramsJSON: #"{"limit":7}"#))
        let read = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-claude-read",
            command: MacNodeClaudeSessionCatalogContract.readCommand,
            paramsJSON: #"{"threadId":"thread-1","limit":20}"#))

        #expect(list.ok)
        #expect(list.payloadJSON == listPayload)
        #expect(read.ok)
        #expect(read.payloadJSON == readPayload)
    }

    @Test func `Claude catalog worker serializes filesystem operations`() async throws {
        let probe = CatalogWorkerProbe()
        let worker = MacNodeClaudeSessionCatalogWorker(
            listOperation: { _ in probe.run() },
            readOperation: { _ in probe.run() })
        let first = Task { try await worker.list(paramsJSON: nil) }
        while probe.snapshot().calls == 0 {
            await Task.yield()
        }
        let second = Task { try await worker.read(paramsJSON: nil) }
        try await Task.sleep(for: .milliseconds(50))

        #expect(probe.snapshot().calls == 1)
        let cancelStarted = ContinuousClock.now
        let watchdog = Task {
            try await Task.sleep(for: .seconds(1))
            probe.release()
        }
        second.cancel()
        await #expect(throws: CancellationError.self) {
            try await second.value
        }
        #expect(ContinuousClock.now - cancelStarted < .milliseconds(500))
        watchdog.cancel()
        probe.release()
        #expect(try await first.value == "call-1")
        #expect(try await worker.read(paramsJSON: nil) == "call-2")
        #expect(probe.snapshot().peakActive == 1)
    }

    @Test func `Claude catalog worker propagates caller cancellation`() async {
        let started = AsyncStream<Void>.makeStream()
        let worker = MacNodeClaudeSessionCatalogWorker(
            listOperation: { _ in
                started.continuation.yield()
                while !Task.isCancelled {
                    Thread.sleep(forTimeInterval: 0.001)
                }
                throw CancellationError()
            },
            readOperation: { _ in "unused" })
        let task = Task { try await worker.list(paramsJSON: nil) }
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(5))
            started.continuation.finish()
        }
        var iterator = started.stream.makeAsyncIterator()
        #expect(await iterator.next() != nil)
        watchdog.cancel()
        started.continuation.finish()

        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }

    @Test func `handle invoke enforces local Claude catalog policy`() async {
        let runtime = MacNodeRuntime(
            claudeSessionCatalogEnabled: { false },
            claudeSessionListRequest: { _ in
                Issue.record("disabled Claude catalog request must not execute")
                return #"{"sessions":[]}"#
            })
        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-claude-disabled",
            command: MacNodeClaudeSessionCatalogContract.listCommand))

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: Claude session catalog is disabled")
    }

    @Test func `A2UI host capability refresh uses injected node session refresher`() async {
        let probe = CanvasRefreshProbe()
        let resolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: { "http://127.0.0.1:18789/__openclaw__/cap/current-token" },
            refreshSurfaceURL: { _ in await probe.refresh() })

        let current = await resolver.resolveA2UIURL()
        #expect(current ==
            "http://127.0.0.1:18789/__openclaw__/cap/current-token/__openclaw__/a2ui/?platform=macos")
        #expect(await probe.calls == 0)

        let refreshed = await resolver.resolveA2UIURL(forceRefresh: true)
        #expect(refreshed ==
            "http://127.0.0.1:18789/__openclaw__/cap/refreshed-token/__openclaw__/a2ui/?platform=macos")
        #expect(await probe.calls == 1)
    }

    @Test func `hosted Canvas commands refresh capability and preserve target components`() async throws {
        let probe = CanvasRefreshProbe()
        let resolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: { "http://127.0.0.1:18789/__openclaw__/cap/current-token" },
            refreshSurfaceURL: { _ in await probe.refresh() })

        let resolved = try await resolver.resolveTarget(
            "/__openclaw__/canvas/demo%20page.html?mode=proof#result")
        #expect(resolved?.url.absoluteString ==
            "http://127.0.0.1:18789/__openclaw__/cap/refreshed-token/__openclaw__/canvas/demo%20page.html?mode=proof#result")
        #expect(resolved?.allowsA2UIActions == false)
        #expect(await probe.calls == 1)

        let external = try await resolver.resolveTarget("https://example.com/")
        #expect(external == nil)
        #expect(await probe.calls == 1)
    }

    @Test func `hosted Canvas commands use replacement route after refresh fails`() async throws {
        let probe = CanvasReconnectProbe()
        let resolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: { await probe.current() },
            refreshSurfaceURL: { _ in await probe.reconnectDuringRefresh() })

        let resolved = try await resolver.resolveTarget("/__openclaw__/canvas/demo.html")

        #expect(resolved?.url.absoluteString ==
            "http://127.0.0.1:18789/__openclaw__/cap/new-token/__openclaw__/canvas/demo.html")
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: OpenClawSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: OpenClawCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `handle invoke screen record uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> ScreenSnapshotResult
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                return ScreenSnapshotResult(
                    data: Data("snapshot".utf8),
                    format: format ?? .jpeg,
                    width: 640,
                    height: 360,
                    displayFrameId: "display-frame-test")
            }

            func recordScreen(
                screenIndex _: Int?,
                durationMs _: Int?,
                fps _: Double?,
                includeAudio _: Bool?,
                outPath _: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy _: OpenClawLocationAccuracy,
                maxAgeMs _: Int?,
                timeoutMs _: Int?) async throws -> CLLocation
            {
                CLLocation(latitude: 0, longitude: 0)
            }

            func performComputerAct(
                _ params: OpenClawComputerActParams,
                lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
            {
                _ = params
                _ = lifecycleGeneration
                return OpenClawComputerActResult(ok: true, cursorX: 0, cursorY: 0)
            }

            func releaseHeldInput(lifecycleGeneration: UInt64) async {
                _ = lifecycleGeneration
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenRecordParams(durationMs: 250)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-5", command: MacNodeScreenCommand.record.rawValue, paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
        }
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "mp4")
        #expect(!payload.base64.isEmpty)
    }

    @Test func `handle invoke screen snapshot uses injected services`() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            var snapshotCalledAtMs: Int64?

            func snapshotScreen(
                screenIndex: Int?,
                maxWidth: Int?,
                quality: Double?,
                format: OpenClawScreenSnapshotFormat?) async throws
                -> ScreenSnapshotResult
            {
                self.snapshotCalledAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                #expect(screenIndex == 0)
                #expect(maxWidth == 800)
                #expect(quality == 0.5)
                return ScreenSnapshotResult(
                    data: Data("ok".utf8),
                    format: format ?? .jpeg,
                    width: 800,
                    height: 450,
                    displayFrameId: "display-frame-test")
            }

            func recordScreen(
                screenIndex _: Int?,
                durationMs _: Int?,
                fps _: Double?,
                includeAudio _: Bool?,
                outPath _: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager().temporaryDirectory
                    .appendingPathComponent("openclaw-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus {
                .authorizedAlways
            }

            func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
                .fullAccuracy
            }

            func currentLocation(
                desiredAccuracy: OpenClawLocationAccuracy,
                maxAgeMs: Int?,
                timeoutMs: Int?) async throws -> CLLocation
            {
                _ = desiredAccuracy
                _ = maxAgeMs
                _ = timeoutMs
                return CLLocation(latitude: 0, longitude: 0)
            }

            func performComputerAct(
                _ params: OpenClawComputerActParams,
                lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
            {
                _ = params
                _ = lifecycleGeneration
                return OpenClawComputerActResult(ok: true, cursorX: 0, cursorY: 0)
            }

            func releaseHeldInput(lifecycleGeneration: UInt64) async {
                _ = lifecycleGeneration
            }
        }

        let services = await MainActor.run { FakeMainActorServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let params = MacNodeScreenSnapshotParams(
            screenIndex: 0,
            maxWidth: 800,
            quality: 0.5,
            format: .jpeg)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot",
                command: MacNodeScreenCommand.snapshot.rawValue,
                paramsJSON: json))
        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)

        struct Payload: Decodable {
            var format: String
            var base64: String
            var displayFrameId: String
            var width: Int
            var height: Int
            var capturedAtMs: Int64
        }

        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "jpeg")
        #expect(payload.base64 == Data("ok".utf8).base64EncodedString())
        #expect(payload.displayFrameId == "display-frame-test")
        #expect(payload.width == 800)
        #expect(payload.height == 450)
        #expect(payload.capturedAtMs > 0)
        let snapshotCalledAtMs = await MainActor.run { services.snapshotCalledAtMs }
        #expect(snapshotCalledAtMs != nil)
        #expect(payload.capturedAtMs <= snapshotCalledAtMs!)
    }

    @Test func `handle invoke screen snapshot rejects malformed params before capture`() async {
        let services = await MainActor.run { ScreenSnapshotProbeServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-invalid",
                command: MacNodeScreenCommand.snapshot.rawValue,
                paramsJSON: #"{"screenIndex":"#))

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid screen snapshot params")
        let snapshotCallCount = await MainActor.run { services.snapshotCallCount }
        #expect(snapshotCallCount == 0)
    }

    @Test func `handle invoke screen snapshot keeps nil params as defaults`() async {
        let services = await MainActor.run { ScreenSnapshotProbeServices() }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-defaults",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == true)
        let received = await MainActor.run { services.receivedSnapshotParams }
        #expect(received == MacNodeScreenSnapshotParams())
    }

    @MainActor
    final class ComputerActProbeServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
        var receivedParams: OpenClawComputerActParams?
        var actError: Error?
        var performCallCount = 0
        var releaseCallCount = 0
        var receivedLifecycleGenerations: [UInt64] = []
        var receivedReleaseGenerations: [UInt64] = []
        private let performEnteredGate: AsyncGate?
        private let allowPerformGate: AsyncGate?
        private var latestLifecycleGeneration: UInt64 = 0

        init(
            actError: Error? = nil,
            performEnteredGate: AsyncGate? = nil,
            allowPerformGate: AsyncGate? = nil)
        {
            self.actError = actError
            self.performEnteredGate = performEnteredGate
            self.allowPerformGate = allowPerformGate
        }

        func snapshotScreen(
            screenIndex _: Int?,
            maxWidth _: Int?,
            quality _: Double?,
            format: OpenClawScreenSnapshotFormat?) async throws
            -> ScreenSnapshotResult
        {
            ScreenSnapshotResult(
                data: Data("ok".utf8),
                format: format ?? .jpeg,
                width: 10,
                height: 10,
                displayFrameId: "display-frame-test")
        }

        func recordScreen(
            screenIndex _: Int?,
            durationMs _: Int?,
            fps _: Double?,
            includeAudio _: Bool?,
            outPath _: String?) async throws -> (path: String, hasAudio: Bool)
        {
            (path: "/tmp/none", hasAudio: false)
        }

        func locationAuthorizationStatus() -> CLAuthorizationStatus {
            .authorizedAlways
        }

        func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
            .fullAccuracy
        }

        func currentLocation(
            desiredAccuracy _: OpenClawLocationAccuracy,
            maxAgeMs _: Int?,
            timeoutMs _: Int?) async throws -> CLLocation
        {
            CLLocation(latitude: 0, longitude: 0)
        }

        func performComputerAct(
            _ params: OpenClawComputerActParams,
            lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
        {
            self.performCallCount += 1
            self.receivedParams = params
            self.receivedLifecycleGenerations.append(lifecycleGeneration)
            await self.performEnteredGate?.open()
            await self.allowPerformGate?.wait()
            guard lifecycleGeneration >= self.latestLifecycleGeneration else {
                throw ComputerActionService.ComputerActionError.lifecycleChanged
            }
            if lifecycleGeneration > self.latestLifecycleGeneration {
                self.latestLifecycleGeneration = lifecycleGeneration
            }
            if let actError {
                throw actError
            }
            return OpenClawComputerActResult(ok: true, cursorX: params.x ?? 0, cursorY: params.y ?? 0)
        }

        func releaseHeldInput(lifecycleGeneration: UInt64) async {
            guard lifecycleGeneration > self.latestLifecycleGeneration else { return }
            self.latestLifecycleGeneration = lifecycleGeneration
            self.receivedReleaseGenerations.append(lifecycleGeneration)
            self.releaseCallCount += 1
        }
    }

    @Test func `handle invoke rejects computer act when control disabled`() async throws {
        let services = await MainActor.run { ComputerActProbeServices() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            computerControlEnabled: { false })

        let params = OpenClawComputerActParams(action: .leftClick, x: 5, y: 6, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-computer-disabled",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "COMPUTER_DISABLED: enable Computer Control in Settings")
        let received = await MainActor.run { services.receivedParams }
        #expect(received == nil)
    }

    @Test func `handle invoke routes computer act to the injected services when enabled`() async throws {
        let services = await MainActor.run { ComputerActProbeServices() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            computerControlEnabled: { true })

        let params = OpenClawComputerActParams(action: .leftClick, x: 12, y: 34, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-computer-ok",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))

        #expect(response.ok == true)
        let received = await MainActor.run { services.receivedParams }
        #expect(received?.action == .leftClick)
        #expect(received?.x == 12)
        let payloadJSON = try #require(response.payloadJSON)
        let result = try JSONDecoder().decode(OpenClawComputerActResult.self, from: Data(payloadJSON.utf8))
        #expect(result.ok == true)
        #expect(result.cursorX == 12)
    }

    @Test func `concurrent invokes share one main actor services initialization`() async throws {
        let services = await MainActor.run { ComputerActProbeServices() }
        let factoryGate = AsyncGate()
        let factoryCalls = LockedCounter()
        let admissionCalls = LockedCounter()
        let runtime = MacNodeRuntime(
            makeMainActorServices: {
                factoryCalls.increment()
                await factoryGate.wait()
                return services
            },
            computerControlEnabled: {
                admissionCalls.increment()
                return true
            })
        let params = OpenClawComputerActParams(action: .leftClick, x: 12, y: 34, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

        let first = Task {
            await runtime.handleInvoke(BridgeInvokeRequest(
                id: "req-computer-single-flight-1",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))
        }
        #expect(await self.waitForCount(1, counter: factoryCalls))
        let second = Task {
            await runtime.handleInvoke(BridgeInvokeRequest(
                id: "req-computer-single-flight-2",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))
        }
        #expect(await self.waitForCount(2, counter: admissionCalls))
        // The actor barrier proves the second invoke reached its first suspension.
        await runtime.updateMainSessionKey("single-flight-barrier")

        #expect(factoryCalls.value() == 1)
        await factoryGate.open()
        let firstResponse = await first.value
        let secondResponse = await second.value
        #expect(firstResponse.ok)
        #expect(secondResponse.ok)
    }

    @Test func `lifecycle release invalidates first invoke awaiting service initialization`() async throws {
        let services = await MainActor.run { ComputerActProbeServices() }
        let factoryGate = AsyncGate()
        let factoryCalls = LockedCounter()
        let runtime = MacNodeRuntime(
            makeMainActorServices: {
                factoryCalls.increment()
                await factoryGate.wait()
                return services
            },
            computerControlEnabled: { true })
        let params = OpenClawComputerActParams(action: .leftMouseDown, x: 12, y: 34, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let invoke = Task {
            await runtime.handleInvoke(BridgeInvokeRequest(
                id: "req-computer-release-during-init",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))
        }
        #expect(await self.waitForCount(1, counter: factoryCalls))

        await runtime.releaseHeldComputerInput()
        await factoryGate.open()
        let response = await invoke.value
        let counts = await MainActor.run {
            (perform: services.performCallCount, release: services.releaseCallCount)
        }

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: computer control lifecycle changed")
        #expect(counts.perform == 0)
        #expect(counts.release == 0)
    }

    @Test func `lifecycle release after runtime admission invalidates service execution`() async throws {
        let performEntered = AsyncGate()
        let allowPerform = AsyncGate()
        let services = await MainActor.run {
            ComputerActProbeServices(
                performEnteredGate: performEntered,
                allowPerformGate: allowPerform)
        }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            computerControlEnabled: { true })
        let params = OpenClawComputerActParams(action: .leftMouseDown, x: 12, y: 34, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let invoke = Task {
            await runtime.handleInvoke(BridgeInvokeRequest(
                id: "req-computer-release-after-admission",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))
        }
        await performEntered.wait()

        await runtime.releaseHeldComputerInput()
        await allowPerform.open()
        let response = await invoke.value
        let generations = await MainActor.run {
            (
                perform: services.receivedLifecycleGenerations,
                release: services.receivedReleaseGenerations)
        }

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message.contains("lifecycle changed") == true)
        #expect(generations.perform == [0])
        #expect(generations.release == [1])
    }

    @Test func `handle invoke maps accessibility denial to unavailable`() async throws {
        let services = await MainActor.run {
            ComputerActProbeServices(actError: ComputerActionService.ComputerActionError.accessibilityNotTrusted)
        }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            computerControlEnabled: { true })

        let params = OpenClawComputerActParams(action: .leftClick, x: 1, y: 1, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-computer-ax",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: json))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "ACCESSIBILITY_REQUIRED: grant Accessibility permission to OpenClaw")
    }

    @Test func `handle invoke rejects malformed computer act params`() async {
        let services = await MainActor.run { ComputerActProbeServices() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { services },
            computerControlEnabled: { true })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-computer-bad",
                command: OpenClawComputerCommand.act.rawValue,
                paramsJSON: #"{"action":"#))

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid computer.act params")
    }

    @Test func `handle invoke screen snapshot sanitizes capture failures`() async {
        struct SensitiveError: LocalizedError {
            let detail: String
            var errorDescription: String? {
                self.detail
            }
        }

        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotError: SensitiveError(detail: "TCC_DENIED display-id=ABC123"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-error",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: screen snapshot failed")
    }

    @Test func `handle invoke screen snapshot reports validation failures as invalid request`() async {
        let invalidIndexServices = await MainActor.run {
            ScreenSnapshotProbeServices(
                snapshotError: ScreenSnapshotService.ScreenSnapshotError.invalidScreenIndex(4))
        }
        let invalidIndexRuntime = MacNodeRuntime(makeMainActorServices: { invalidIndexServices })
        let invalidIndexResponse = await invalidIndexRuntime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-bad-index",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(invalidIndexResponse.ok == false)
        #expect(invalidIndexResponse.error?.code == .invalidRequest)
        #expect(invalidIndexResponse.error?.message == "INVALID_REQUEST: invalid screen index 4")

        let noDisplaysServices = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotError: ScreenSnapshotService.ScreenSnapshotError.noDisplays)
        }
        let noDisplaysRuntime = MacNodeRuntime(makeMainActorServices: { noDisplaysServices })
        let noDisplaysResponse = await noDisplaysRuntime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-no-displays",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(noDisplaysResponse.ok == false)
        #expect(noDisplaysResponse.error?.code == .invalidRequest)
        #expect(
            noDisplaysResponse.error?.message ==
                "INVALID_REQUEST: no displays available for screen snapshot")
    }

    @Test func `handle invoke screen snapshot rejects raw payloads above base64 ceiling`() async {
        let payloadSize = 19_660_801
        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0x41, count: payloadSize),
                format: .jpeg,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-too-large",
                command: MacNodeScreenCommand.snapshot.rawValue))

        #expect(response.ok == false)
        #expect(response.payloadJSON == nil)
        #expect(response.error?.code == .unavailable)
        #expect(
            response.error?.message ==
                "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    @Test func `handle invoke screen snapshot rejects escaped oversized outer frames`() async {
        let payloadSize = 12 * 1024 * 1024
        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0xFF, count: payloadSize),
                format: .png,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-screen-snapshot-slash-heavy",
                command: MacNodeScreenCommand.snapshot.rawValue,
                nodeId: "node-slash-heavy"))

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(
            response.error?.message ==
                "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    @Test func `handle invoke screen snapshot accepts near-limit frames that fit`() async throws {
        let payloadSize = 19_660_100
        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0x00, count: payloadSize),
                format: .jpeg,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { services })

        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-fit",
                command: MacNodeScreenCommand.snapshot.rawValue,
                nodeId: "node-fit"))

        #expect(response.ok == true)
        let payloadJSON = try #require(response.payloadJSON)
        let projected = try MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: payloadJSON,
            requestId: "req-fit",
            nodeId: "node-fit")
        #expect(projected < 25 * 1024 * 1024)
    }

    @Test func `projected outer frame bytes accounts for dynamic node id escaping`() throws {
        let inner = "{\"format\":\"png\",\"note\":\"\u{0001}\u{0002}\n\t\\\"raw\\\"\",\"width\":1,\"height\":1,\"capturedAtMs\":0}"
        let projected = try MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: inner,
            requestId: "req-control",
            nodeId: "node-\u{0001}\u{0002}\u{0003}\n\t-id")

        struct Frame: Encodable {
            let type = "req"
            let id = "00000000-0000-0000-0000-000000000000"
            let method = "node.invoke.result"
            let params: Params

            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }
        let serialized = try JSONEncoder().encode(Frame(params: Frame.Params(
            id: "req-control",
            nodeId: "node-\u{0001}\u{0002}\u{0003}\n\t-id",
            ok: true,
            payloadJSON: inner)))

        #expect(projected == serialized.count)

        let controlHeavyNodeId = String(repeating: "\u{0001}", count: 5 * 1024 * 1024)
        let controlHeavyProjection = try MacNodeRuntime.projectedOuterFrameBytes(
            forPayloadJSON: "{}",
            requestId: "req-control",
            nodeId: controlHeavyNodeId)
        #expect(controlHeavyProjection > 25 * 1024 * 1024)
    }
}
