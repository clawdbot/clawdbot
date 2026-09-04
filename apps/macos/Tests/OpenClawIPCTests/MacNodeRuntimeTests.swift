import CoreLocation
import Dispatch
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    private actor ComputerProviderWorkerProbe: MacNodeHostWorking {
        private let commands: Set<String>
        private(set) var invokedCommands: [String] = []

        init(commands: Set<String>) {
            self.commands = commands
        }

        func start(launch _: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest {
            MacNodeHostManifest(
                version: "test",
                caps: ["screen", "computer"],
                commands: Array(self.commands),
                pathEnv: "/usr/bin:/bin")
        }

        func supports(_ command: String) -> Bool {
            self.commands.contains(command)
        }

        func invoke(_ request: BridgeInvokeRequest) -> BridgeInvokeResponse {
            self.invokedCommands.append(request.command)
            return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: #"{"owner":"worker"}"#)
        }

        func handleInput(invokeId _: String, seq _: Int, payloadJSON _: String) {}
        func cancel(invokeId _: String) {}
        func setRoute(_: GatewayNodeSessionRoute?, authorityGeneration _: UInt64) -> Bool {
            true
        }

        func gatewayConnected(ifCurrentRoute _: GatewayNodeSessionRoute) {}
        func stop() {}
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
        let firstStarted = AsyncTestGate()
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
                self.firstStarted.open()
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

    private func invoke(
        _ runtime: MacNodeRuntime,
        _ id: String,
        _ command: String,
        _ paramsJSON: String? = nil,
        nodeId: String? = nil) async -> BridgeInvokeResponse
    {
        await runtime.handleInvoke(BridgeInvokeRequest(
            id: id,
            command: command,
            paramsJSON: paramsJSON,
            nodeId: nodeId))
    }

    private func invoke(
        _ runtime: MacNodeRuntime,
        _ id: String,
        _ command: String,
        params: some Encodable,
        nodeId: String? = nil) async throws -> BridgeInvokeResponse
    {
        try await self.invoke(
            runtime,
            id,
            command,
            String(decoding: JSONEncoder().encode(params), as: UTF8.self),
            nodeId: nodeId)
    }

    private func invoke(
        _ fixture: MacNodeComputerExecutionFixture,
        _ id: String,
        _ command: String,
        _ paramsJSON: String? = nil) async throws -> BridgeInvokeResponse
    {
        try await fixture.invoke(BridgeInvokeRequest(id: id, command: command, paramsJSON: paramsJSON))
    }

    private func invoke(
        _ fixture: MacNodeComputerExecutionFixture,
        _ id: String,
        _ command: String,
        params: some Encodable) async throws -> BridgeInvokeResponse
    {
        try await self.invoke(fixture, id, command, String(decoding: JSONEncoder().encode(params), as: UTF8.self))
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
    final class MainActorServicesProbe: MacNodeRuntimeMainActorServices, @unchecked Sendable {
        typealias SnapshotInspection = (Int?, Int?, Double?, OpenClawScreenSnapshotFormat?) -> Void

        var snapshotCallCount = 0
        var receivedSnapshotParams: MacNodeScreenSnapshotParams?
        var snapshotResult: ScreenSnapshotResult
        var snapshotError: Error?
        var snapshotCalledAtMs: Int64?
        var receivedParams: OpenClawComputerActParams?
        var actError: Error?
        var performCallCount = 0
        var releaseCallCount = 0
        var invalidationCallCount = 0
        var locationStatus: CLAuthorizationStatus
        var receivedLifecycleGenerations: [UInt64] = []
        var queue: ComputerActionExecutionQueue?
        private let snapshotInspection: SnapshotInspection?
        private let performEnteredGate: AsyncTestGate?
        private let allowPerformGate: AsyncTestGate?

        init(
            snapshotResult: ScreenSnapshotResult = ScreenSnapshotResult(
                data: Data("ok".utf8),
                format: .jpeg,
                width: 10,
                height: 10,
                displayFrameId: "display-frame-test"),
            snapshotError: Error? = nil,
            snapshotInspection: SnapshotInspection? = nil,
            actError: Error? = nil,
            locationAuthorizationStatus: CLAuthorizationStatus = .authorizedAlways,
            performEnteredGate: AsyncTestGate? = nil,
            allowPerformGate: AsyncTestGate? = nil)
        {
            self.snapshotResult = snapshotResult
            self.snapshotError = snapshotError
            self.snapshotInspection = snapshotInspection
            self.actError = actError
            self.locationStatus = locationAuthorizationStatus
            self.performEnteredGate = performEnteredGate
            self.allowPerformGate = allowPerformGate
        }

        func snapshotScreen(
            screenIndex: Int?,
            maxWidth: Int?,
            quality: Double?,
            format: OpenClawScreenSnapshotFormat?,
            checkExecutionAllowed: @MainActor () throws -> Void) async throws -> ScreenSnapshotResult
        {
            try checkExecutionAllowed()
            self.snapshotCallCount += 1
            self.snapshotCalledAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            self.receivedSnapshotParams = MacNodeScreenSnapshotParams(
                screenIndex: screenIndex,
                maxWidth: maxWidth,
                quality: quality,
                format: format)
            self.snapshotInspection?(screenIndex, maxWidth, quality, format)
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
            self.locationStatus
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
            self.performCallCount += 1
            self.receivedParams = params
            self.receivedLifecycleGenerations.append(lifecycleGeneration)
            self.performEnteredGate?.open()
            await self.allowPerformGate?.wait()
            try Task.checkCancellation()
            if let actError {
                throw actError
            }
            return OpenClawComputerActResult(ok: true)
        }

        func releaseHeldInput() -> Bool {
            self.releaseCallCount += 1
            return true
        }

        func invalidateComputerReferences() async throws {
            self.invalidationCallCount += 1
        }
    }

    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await invoke(runtime, "req-1", "unknown.command")
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
        let response = await invoke(
            runtime, "req-codex-threads", MacNodeCodexThreadCatalogContract.listCommand, #"{"limit":7}"#)

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
        let response = await invoke(
            runtime, "req-codex-disabled", MacNodeCodexThreadCatalogContract.listCommand)

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
        let response = await invoke(
            runtime, "req-codex-items", MacNodeCodexThreadCatalogContract.turnsCommand,
            #"{"threadId":"thread-1","limit":50}"#)

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

        let list = await invoke(
            runtime, "req-claude-list", MacNodeClaudeSessionCatalogContract.listCommand, #"{"limit":7}"#)
        let read = await invoke(
            runtime, "req-claude-read", MacNodeClaudeSessionCatalogContract.readCommand,
            #"{"threadId":"thread-1","limit":20}"#)

        #expect(list.ok)
        #expect(list.payloadJSON == listPayload)
        #expect(read.ok)
        #expect(read.payloadJSON == readPayload)
    }

    @Test func `Claude catalog worker serializes filesystem operations`() async throws {
        let secondStarted = AsyncTestGate()
        let probe = CatalogWorkerProbe()
        let worker = MacNodeClaudeSessionCatalogWorker(
            listOperation: { _ in probe.run() },
            readOperation: { _ in probe.run() })
        let first = Task { try await worker.list(paramsJSON: nil) }
        let second = Task {
            await probe.firstStarted.wait()
            secondStarted.open()
            return try await worker.read(paramsJSON: nil)
        }
        let watchdog = Task {
            try await Task.sleep(for: .seconds(10))
            Issue.record("timed out waiting for Claude catalog worker cancellation")
            probe.firstStarted.open()
            secondStarted.open()
            probe.release()
        }
        defer {
            watchdog.cancel()
            first.cancel()
            second.cancel()
            probe.release()
        }
        await probe.firstStarted.wait()
        await secondStarted.wait()

        #expect(probe.snapshot().calls == 1)
        second.cancel()
        await #expect(throws: CancellationError.self) {
            try await second.value
        }
        #expect(probe.snapshot().calls == 1)
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
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            Issue.record("timed out waiting for Claude catalog worker start")
            task.cancel()
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
        let response = await invoke(
            runtime, "req-claude-disabled", MacNodeClaudeSessionCatalogContract.listCommand)

        #expect(!response.ok)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: Claude session catalog is disabled")
    }

    @Test func `hosted Canvas commands refresh capability and preserve target components`() async throws {
        let probe = CanvasRefreshProbe()
        let resolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: { "http://127.0.0.1:18789/__openclaw__/cap/current-token" },
            refreshSurfaceURL: { _ in await probe.refresh() })

        let resolved = try await resolver.resolveTarget(
            "/__openclaw__/canvas/demo%20page.html?mode=proof#result")
        #expect(resolved?.absoluteString ==
            "http://127.0.0.1:18789/__openclaw__/cap/refreshed-token/__openclaw__/canvas/demo%20page.html?mode=proof#result")
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

        #expect(resolved?.absoluteString ==
            "http://127.0.0.1:18789/__openclaw__/cap/new-token/__openclaw__/canvas/demo.html")
    }

    @Test func `removed Canvas commands are unknown even when Canvas is disabled`() async {
        await TestIsolation.withUserDefaultsValues([canvasEnabledKey: false]) {
            let response = await self.invoke(MacNodeRuntime(), "req-canvas-eval", "canvas.eval")

            #expect(response.error?.code == .invalidRequest)
            #expect(response.error?.message == "INVALID_REQUEST: unknown command")
        }
    }

    @Test func `Canvas commands reject arbitrary web targets`() async {
        await TestIsolation.withUserDefaultsValues([canvasEnabledKey: true]) {
            let response = await self.invoke(
                MacNodeRuntime(),
                "req-canvas-external",
                OpenClawCanvasCommand.navigate.rawValue,
                #"{"url":"https://example.com/widget.html"}"#)

            #expect(response.error?.code == .invalidRequest)
            #expect(response.error?.message ==
                "INVALID_REQUEST: canvas target must be a hosted widget-document path or app-local Canvas URL")
        }
    }

    @Test func `handle invoke rejects empty notification`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(title: "", body: "")
        let response = try await invoke(
            runtime, "req-3", OpenClawSystemCommand.notify.rawValue, params: params)
        #expect(response.ok == false)
    }

    @Test @MainActor func `cancelled notification cannot present an overlay`() async throws {
        let overlay = NotifyOverlayController.shared
        try #require(!overlay.model.isVisible)
        defer { overlay.dismiss() }
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemNotifyParams(
            title: "Cancelled notification test",
            body: "This overlay must not appear.",
            delivery: .overlay)
        let request = Task { @MainActor in
            try await self.invoke(
                runtime,
                "cancelled-overlay",
                OpenClawSystemCommand.notify.rawValue,
                params: params)
        }
        request.cancel()
        let response = try await request.value

        #expect(!response.ok)
        #expect(!overlay.model.isVisible)
    }

    @Test func `handle invoke camera list requires enabled camera`() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await self.invoke(runtime, "req-4", OpenClawCameraCommand.list.rawValue)
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func `handle location invoke applies authorization required by mode`() async throws {
        let authorizedWhenInUse = try #require(CLAuthorizationStatus(rawValue: 4))
        let cases: [(mode: OpenClawLocationMode, status: CLAuthorizationStatus, accepted: Bool)] = [
            (.whileUsing, authorizedWhenInUse, true),
            (.always, authorizedWhenInUse, false),
            (.whileUsing, .authorizedAlways, true),
            (.always, .authorizedAlways, true),
        ]

        for testCase in cases {
            await TestIsolation.withUserDefaultsValues([locationModeKey: testCase.mode.rawValue]) {
                let services = await MainActor.run {
                    MainActorServicesProbe(locationAuthorizationStatus: testCase.status)
                }
                let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

                let response = await self.invoke(
                    runtime, "req-location", OpenClawLocationCommand.get.rawValue)

                #expect(response.ok == testCase.accepted)
            }
        }
    }

    @Test func `handle invoke screen record uses injected services`() async throws {
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let params = MacNodeScreenRecordParams(durationMs: 250)
        let response = try await invoke(
            runtime, "req-5", MacNodeScreenCommand.record.rawValue, params: params)
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
        let services = await MainActor.run {
            MainActorServicesProbe(
                snapshotResult: ScreenSnapshotResult(
                    data: Data("ok".utf8),
                    format: .jpeg,
                    width: 800,
                    height: 450,
                    displayFrameId: "display-frame-test"),
                snapshotInspection: { screenIndex, maxWidth, quality, _ in
                    #expect(screenIndex == 0)
                    #expect(maxWidth == 800)
                    #expect(quality == 0.5)
                })
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let params = MacNodeScreenSnapshotParams(
            screenIndex: 0,
            maxWidth: 800,
            quality: 0.5,
            format: .jpeg)
        let response = try await invoke(
            runtime, "req-screen-snapshot", MacNodeScreenCommand.snapshot.rawValue, params: params)
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
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-screen-snapshot-invalid", MacNodeScreenCommand.snapshot.rawValue, #"{"screenIndex":"#)

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message == "INVALID_REQUEST: invalid screen snapshot params")
        let snapshotCallCount = await MainActor.run { services.snapshotCallCount }
        #expect(snapshotCallCount == 0)
    }

    @Test func `handle invoke screen snapshot keeps nil params as defaults`() async {
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-screen-snapshot-defaults", MacNodeScreenCommand.snapshot.rawValue)

        #expect(response.ok == true)
        let received = await MainActor.run { services.receivedSnapshotParams }
        #expect(received == MacNodeScreenSnapshotParams())
    }

    @Test func `handle invoke rejects computer act when control disabled`() async throws {
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in services },
            computerControlEnabled: { false },
            computerControlProvider: { .peekaboo })

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            let params = OpenClawComputerActParams(action: .leftClick, executionId: UUID(), x: 5, y: 6, refWidth: 1280)
            let response = try await invoke(
                fixture, "req-computer-disabled", OpenClawComputerCommand.act.rawValue, params: params)

            #expect(response.ok == false)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message == "COMPUTER_DISABLED: enable Computer Control in Settings")
            let received = await MainActor.run { services.receivedParams }
            #expect(received == nil)
        }
    }

    @Test func `handle invoke routes computer act to the injected services when enabled`() async throws {
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in services },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            let params = OpenClawComputerActParams(
                action: .leftClick,
                executionId: UUID(),
                x: 12,
                y: 34,
                refWidth: 1280)
            let response = try await invoke(
                fixture, "req-computer-ok", OpenClawComputerCommand.act.rawValue, params: params)

            #expect(response.ok == true)
            let received = await MainActor.run { services.receivedParams }
            #expect(received?.action == .leftClick)
            #expect(received?.x == 12)
            let payloadJSON = try #require(response.payloadJSON)
            let result = try JSONDecoder().decode(OpenClawComputerActResult.self, from: Data(payloadJSON.utf8))
            #expect(result.ok == true)
            let object = try #require(JSONSerialization.jsonObject(with: Data(payloadJSON.utf8)) as? [String: Any])
            #expect(object.keys.sorted() == ["ok"])
        }
    }

    @Test func `provider selection owns both snapshot and action without cross-provider fallback`() async throws {
        let commands: Set<String> = [MacNodeScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue]
        let cuaWorker = ComputerProviderWorkerProbe(commands: commands)
        let cuaServices = await MainActor.run { MainActorServicesProbe() }
        let cuaRuntime = MacNodeRuntime(
            nodeHostWorker: cuaWorker,
            makeMainActorServices: { _ in cuaServices },
            computerControlEnabled: { true },
            computerControlProvider: { .cua })
        let executionId = UUID()
        let action = OpenClawComputerActParams(
            action: .leftClick, executionId: executionId, x: 12, y: 34, refWidth: 1280)

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: cuaRuntime)
            #expect(try await (self.invoke(
                fixture,
                "cua-snapshot",
                MacNodeScreenCommand.snapshot.rawValue)).ok)
            #expect(try await (self.invoke(
                fixture,
                "cua-action",
                OpenClawComputerCommand.act.rawValue,
                params: action)).ok)
            let browserAction = try String(decoding: JSONEncoder().encode([
                "action": "browser_click", "executionId": executionId.uuidString.lowercased(), "ref": "synthetic-ref",
            ]), as: UTF8.self)
            #expect(try await self.invoke(fixture, "cua-browser-action", "computer.act", browserAction).ok)
            let close = try String(decoding: JSONEncoder().encode([
                "action": "__close_execution", "executionId": executionId.uuidString.lowercased(),
                "reason": "test_complete",
            ]), as: UTF8.self)
            #expect(try await self.invoke(fixture, "cua-close", "computer.act", close).ok)
            #expect(await cuaWorker.invokedCommands == [
                MacNodeScreenCommand.snapshot.rawValue,
                OpenClawComputerCommand.act.rawValue,
                OpenClawComputerCommand.act.rawValue,
                OpenClawComputerCommand.act.rawValue,
            ])
            #expect(await MainActor.run { cuaServices.snapshotCallCount == 0 && cuaServices.performCallCount == 0 })
        }

        let peekabooWorker = ComputerProviderWorkerProbe(commands: commands)
        let peekabooServices = await MainActor.run { MainActorServicesProbe() }
        let peekabooRuntime = MacNodeRuntime(
            nodeHostWorker: peekabooWorker,
            makeMainActorServices: { _ in peekabooServices },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })
        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: peekabooRuntime)
            #expect(try await (self.invoke(
                fixture,
                "peekaboo-snapshot",
                MacNodeScreenCommand.snapshot.rawValue)).ok)
            #expect(try await (self.invoke(
                fixture,
                "peekaboo-action",
                OpenClawComputerCommand.act.rawValue,
                params: action)).ok)
            #expect(await peekabooWorker.invokedCommands.isEmpty)
            #expect(await MainActor.run {
                peekabooServices.snapshotCallCount == 1 && peekabooServices.performCallCount == 1
            })
        }

        let unavailableWorker = ComputerProviderWorkerProbe(commands: [])
        let unavailableServices = await MainActor.run { MainActorServicesProbe() }
        let unavailableRuntime = MacNodeRuntime(
            nodeHostWorker: unavailableWorker,
            makeMainActorServices: { _ in unavailableServices },
            computerControlEnabled: { true },
            computerControlProvider: { .cua })
        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: unavailableRuntime)
            let unavailable = try await invoke(
                fixture,
                "cua-unavailable",
                MacNodeScreenCommand.snapshot.rawValue)
            #expect(!unavailable.ok)
            #expect(await MainActor.run { unavailableServices.snapshotCallCount == 0 })
        }
    }

    @Test func `concurrent invokes share one main actor services initialization`() async throws {
        let services = await MainActor.run { MainActorServicesProbe() }
        let factoryGate = AsyncTestGate()
        let factoryCalls = LockedCounter()
        let runtime = MacNodeRuntime(
            makeMainActorServices: { queue in
                factoryCalls.increment()
                await MainActor.run { services.queue = queue }
                await factoryGate.wait()
                return services
            },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })
        let params = OpenClawComputerActParams(action: .leftClick, executionId: UUID(), x: 12, y: 34, refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            defer { factoryGate.open() }
            let first = Task {
                try await self.invoke(
                    fixture,
                    "req-computer-single-flight-1",
                    OpenClawComputerCommand.act.rawValue,
                    json)
            }
            try #require(await waitForCount(1, counter: factoryCalls))
            let second = Task {
                try await self.invoke(
                    fixture,
                    "req-computer-single-flight-2",
                    OpenClawComputerCommand.act.rawValue,
                    json)
            }
            try await fixture.waitUntil { services.queue?.pendingActionCountForTesting == 1 }

            #expect(factoryCalls.value() == 1)
            factoryGate.open()
            let firstResponse = try await first.value
            let secondResponse = try await second.value
            #expect(firstResponse.ok)
            #expect(secondResponse.ok)
        }
    }

    @Test func `native close keeps its owner after control is disabled and provider changes`() async throws {
        let settingsChanged = LockedCounter()
        let worker = ComputerProviderWorkerProbe(commands: [OpenClawComputerCommand.act.rawValue])
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(
            nodeHostWorker: worker,
            makeMainActorServices: { _ in services },
            computerControlEnabled: { settingsChanged.value() == 0 },
            computerControlProvider: { settingsChanged.value() == 0 ? .peekaboo : .cua })
        let executionId = UUID()
        let action = OpenClawComputerActParams(
            action: .leftMouseDown, executionId: executionId, x: 12, y: 34, refWidth: 1280)
        let close = try String(decoding: JSONEncoder().encode([
            "action": "__close_execution", "executionId": executionId.uuidString.lowercased(),
            "reason": "test_complete",
        ]), as: UTF8.self)

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            #expect(try await self.invoke(fixture, "native-action", "computer.act", params: action).ok)
            settingsChanged.increment()

            let closed = try await self.invoke(fixture, "native-close-after-flip", "computer.act", close)
            #expect(closed.ok)
            #expect(services.releaseCallCount == 1)
            #expect(services.invalidationCallCount == 1)
            #expect(await worker.invokedCommands.isEmpty)

            let unmatched = try await self.invoke(fixture, "unmatched-close-after-flip", "computer.act", close)
            #expect(!unmatched.ok)
            #expect(unmatched.error?.code == .unavailable)
            #expect(services.releaseCallCount == 1)
            #expect(services.invalidationCallCount == 1)
            #expect(await worker.invokedCommands.isEmpty)
        }
    }

    @Test func `direct computer invocation without a route refuses before service initialization`() async throws {
        let factoryCalls = LockedCounter()
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in
                factoryCalls.increment()
                return services
            },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })
        let executionId = UUID().uuidString.lowercased()
        let action = try String(decoding: JSONEncoder().encode([
            "action": "left_mouse_down", "executionId": executionId,
        ]), as: UTF8.self)
        let snapshot = try String(decoding: JSONEncoder().encode([
            "executionId": executionId,
        ]), as: UTF8.self)
        let close = try String(decoding: JSONEncoder().encode([
            "action": "__close_execution", "executionId": executionId, "reason": "test_complete",
        ]), as: UTF8.self)

        for (id, command, params) in [
            ("direct-action", "computer.act", action),
            ("direct-scoped-snapshot", "screen.snapshot", snapshot),
            ("direct-close", "computer.act", close),
        ] {
            let response = await self.invoke(runtime, id, command, params)
            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
        }
        #expect(factoryCalls.value() == 0)
    }

    @Test func `lifecycle release after runtime admission invalidates service execution`() async throws {
        let performEntered = AsyncTestGate()
        let allowPerform = AsyncTestGate()
        defer {
            performEntered.open()
            allowPerform.open()
        }
        let services = await MainActor.run {
            MainActorServicesProbe(
                performEnteredGate: performEntered,
                allowPerformGate: allowPerform)
        }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in services },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })
        let params = OpenClawComputerActParams(
            action: .leftMouseDown,
            executionId: UUID(),
            x: 12,
            y: 34,
            refWidth: 1280)
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            defer { allowPerform.open() }
            let invoke = Task {
                try await self.invoke(
                    fixture,
                    "req-computer-release-after-admission",
                    OpenClawComputerCommand.act.rawValue,
                    json)
            }
            await performEntered.wait()

            let release = Task { await runtime.releaseHeldComputerInput() }
            while await MainActor.run(body: { services.releaseCallCount == 0 }) {
                await Task.yield()
            }
            allowPerform.open()
            await release.value
            let response = try await invoke.value
            let generations = await MainActor.run {
                (
                    perform: services.receivedLifecycleGenerations,
                    release: services.releaseCallCount)
            }

            #expect(!response.ok)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message.contains("COMPUTER_STALE_OBSERVATION") == true)
            #expect(generations.perform == [0])
            #expect(generations.release >= 2)
        }
    }

    @Test func `handle invoke maps accessibility denial to unavailable`() async throws {
        let services = await MainActor.run {
            MainActorServicesProbe(actError: ComputerActionService.ComputerActionError.accessibilityNotTrusted)
        }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in services },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })

        try await MacNodeComputerExecutionFixture().run { fixture in
            try await fixture.connect(runtime: runtime)
            let params = OpenClawComputerActParams(action: .leftClick, executionId: UUID(), x: 1, y: 1, refWidth: 1280)
            let response = try await invoke(
                fixture, "req-computer-ax", OpenClawComputerCommand.act.rawValue, params: params)

            #expect(response.ok == false)
            #expect(response.error?.code == .unavailable)
            #expect(response.error?.message == "ACCESSIBILITY_REQUIRED: grant Accessibility permission to OpenClaw")
        }
    }

    @Test func `handle invoke rejects malformed computer act params`() async {
        let services = await MainActor.run { MainActorServicesProbe() }
        let runtime = MacNodeRuntime(
            makeMainActorServices: { _ in services },
            computerControlEnabled: { true },
            computerControlProvider: { .peekaboo })

        let response = await invoke(
            runtime, "req-computer-bad", OpenClawComputerCommand.act.rawValue, #"{"action":"#)

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
            MainActorServicesProbe(snapshotError: SensitiveError(detail: "TCC_DENIED display-id=ABC123"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-screen-snapshot-error", MacNodeScreenCommand.snapshot.rawValue)

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "UNAVAILABLE: screen snapshot failed")
    }

    @Test func `handle invoke screen snapshot reports validation failures as invalid request`() async {
        let invalidIndexServices = await MainActor.run {
            MainActorServicesProbe(
                snapshotError: ScreenSnapshotService.ScreenSnapshotError.invalidScreenIndex(4))
        }
        let invalidIndexRuntime = MacNodeRuntime(makeMainActorServices: { _ in invalidIndexServices })
        let invalidIndexResponse = await invoke(
            invalidIndexRuntime, "req-screen-snapshot-bad-index", MacNodeScreenCommand.snapshot.rawValue)

        #expect(invalidIndexResponse.ok == false)
        #expect(invalidIndexResponse.error?.code == .invalidRequest)
        #expect(invalidIndexResponse.error?.message == "INVALID_REQUEST: invalid screen index 4")

        let noDisplaysServices = await MainActor.run {
            MainActorServicesProbe(snapshotError: ScreenSnapshotService.ScreenSnapshotError.noDisplays)
        }
        let noDisplaysRuntime = MacNodeRuntime(makeMainActorServices: { _ in noDisplaysServices })
        let noDisplaysResponse = await invoke(
            noDisplaysRuntime, "req-screen-snapshot-no-displays", MacNodeScreenCommand.snapshot.rawValue)

        #expect(noDisplaysResponse.ok == false)
        #expect(noDisplaysResponse.error?.code == .invalidRequest)
        #expect(
            noDisplaysResponse.error?.message ==
                "INVALID_REQUEST: no displays available for screen snapshot")
    }

    @Test func `handle invoke screen snapshot rejects raw payloads above base64 ceiling`() async {
        let payloadSize = 19_660_801
        let services = await MainActor.run {
            MainActorServicesProbe(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0x41, count: payloadSize),
                format: .jpeg,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-screen-snapshot-too-large", MacNodeScreenCommand.snapshot.rawValue)

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
            MainActorServicesProbe(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0xFF, count: payloadSize),
                format: .png,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-screen-snapshot-slash-heavy", MacNodeScreenCommand.snapshot.rawValue,
            nodeId: "node-slash-heavy")

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(
            response.error?.message ==
                "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    @Test func `handle invoke screen snapshot accepts near-limit frames that fit`() async throws {
        let payloadSize = 19_660_100
        let services = await MainActor.run {
            MainActorServicesProbe(snapshotResult: ScreenSnapshotResult(
                data: Data(repeating: 0x00, count: payloadSize),
                format: .jpeg,
                width: 4000,
                height: 3000,
                displayFrameId: "display-frame-test"))
        }
        let runtime = MacNodeRuntime(makeMainActorServices: { _ in services })

        let response = await invoke(
            runtime, "req-fit", MacNodeScreenCommand.snapshot.rawValue, nodeId: "node-fit")

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
