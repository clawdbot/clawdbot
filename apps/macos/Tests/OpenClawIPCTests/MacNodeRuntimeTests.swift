import CoreLocation
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

    private func waitForCount(_ expected: Int, counter: LockedCounter) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
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

    actor ExecEventProbe {
        private var captured: [(event: String, json: String)] = []

        func append(event: String, json: String?) {
            self.captured.append((event: event, json: json ?? ""))
        }

        func events() -> [(event: String, json: String)] {
            self.captured
        }
    }

    actor ShellRunProbe {
        private var commands: [[String]] = []

        func run(_ command: [String]) -> ShellExecutor.ShellResult {
            self.commands.append(command)
            return ShellExecutor.ShellResult(
                stdout: "",
                stderr: "",
                exitCode: 0,
                timedOut: false,
                success: true,
                errorMessage: nil)
        }

        func capturedCommands() -> [[String]] {
            self.commands
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

    @Test func `file system list directory returns only sorted directories`() async throws {
        struct Entry: Decodable, Equatable {
            var name: String
            var path: String
            var hidden: Bool?
        }
        struct Payload: Decodable {
            var path: String
            var parent: String?
            var home: String
            var entries: [Entry]
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("MacNodeRuntimeTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let projects = root.appendingPathComponent("Projects", isDirectory: true)
        let hidden = root.appendingPathComponent(".hidden", isDirectory: true)
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: hidden, withIntermediateDirectories: false)
        try Data("not a directory".utf8).write(to: root.appendingPathComponent("notes.txt"))

        let paramsJSON = try String(
            decoding: JSONEncoder().encode(["path": root.path]),
            as: UTF8.self)
        let response = await MacNodeRuntime().handleInvoke(BridgeInvokeRequest(
            id: "req-fs-list-dir",
            command: OpenClawFileSystemCommand.listDir.rawValue,
            paramsJSON: paramsJSON))
        let payloadJSON = try #require(response.payloadJSON)
        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))

        #expect(response.ok)
        #expect(payload.path == root.path)
        #expect(payload.parent == root.deletingLastPathComponent().path)
        #expect(payload.home == FileManager.default.homeDirectoryForCurrentUser.path)
        let listedRoot = URL(fileURLWithPath: payload.path, isDirectory: true)
        #expect(payload.entries == [
            Entry(
                name: "Projects",
                path: listedRoot.appendingPathComponent("Projects", isDirectory: true).path,
                hidden: nil),
            Entry(
                name: ".hidden",
                path: listedRoot.appendingPathComponent(".hidden", isDirectory: true).path,
                hidden: true),
        ])
    }

    @Test func `file system list directory rejects relative paths`() async throws {
        let paramsJSON = try String(
            decoding: JSONEncoder().encode(["path": "Projects"]),
            as: UTF8.self)
        let response = await MacNodeRuntime().handleInvoke(BridgeInvokeRequest(
            id: "req-fs-list-dir-relative",
            command: OpenClawFileSystemCommand.listDir.rawValue,
            paramsJSON: paramsJSON))

        #expect(!response.ok)
        #expect(response.error?.code == .invalidRequest)
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
            refreshSurfaceURL: { await probe.refresh() })

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
            refreshSurfaceURL: { await probe.refresh() })

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

    @Test func `handle invoke rejects empty system run`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func `system run rejects raw command prompt spoof before execution`() async throws {
        let probe = ShellRunProbe()
        let runtime = MacNodeRuntime(
            shellRunner: { command, _, _, _ in await probe.run(command) })
        let params = OpenClawSystemRunParams(
            command: ["/usr/bin/printf", "unsafe"],
            rawCommand: "echo safe")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-raw-command-spoof",
            command: OpenClawSystemCommand.run.rawValue,
            paramsJSON: json))

        #expect(!response.ok)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message.contains("rawCommand does not match command") == true)
        #expect(await probe.capturedCommands().isEmpty)
    }

    @Test func `system run rejects mismatched shell payload preview before execution`() async throws {
        let probe = ShellRunProbe()
        let runtime = MacNodeRuntime(
            shellRunner: { command, _, _, _ in await probe.run(command) })
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "/usr/bin/printf unsafe"],
            rawCommand: "echo safe")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-shell-preview-spoof",
            command: OpenClawSystemCommand.run.rawValue,
            paramsJSON: json))

        #expect(!response.ok)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message.contains("rawCommand does not match command") == true)
        #expect(await probe.capturedCommands().isEmpty)
    }

    @Test func `system run shares padded executable rejection with socket host`() async throws {
        let probe = ShellRunProbe()
        let runtime = MacNodeRuntime(
            shellRunner: { command, _, _, _ in await probe.run(command) })
        let params = OpenClawSystemRunParams(command: [" /usr/bin/printf ", "unsafe"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)

        let response = await runtime.handleInvoke(BridgeInvokeRequest(
            id: "req-padded-executable",
            command: OpenClawSystemCommand.run.rawValue,
            paramsJSON: json))

        #expect(!response.ok)
        #expect(response.error?.code == .invalidRequest)
        #expect(response.error?.message.contains("executable has surrounding whitespace") == true)
        #expect(await probe.capturedCommands().isEmpty)
    }

    @Test func `exec approvals snapshot reports resolved host defaults`() async throws {
        let root = URL(
            fileURLWithPath: "/tmp/oc-appr-\(UUID().uuidString.prefix(8))",
            isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let initial = ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        try JSONEncoder().encode(initial)
            .write(to: stateDir.appendingPathComponent("exec-approvals.json"))

        try await TestIsolation.withEnvValues([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let runtime = MacNodeRuntime()
            let legacyResponse = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-approvals-get-legacy",
                    command: OpenClawSystemCommand.execApprovalsGet.rawValue))
            #expect(legacyResponse.ok)
            let legacyPayloadJSON = try #require(legacyResponse.payloadJSON)
            let legacyPayload = try #require(
                JSONSerialization.jsonObject(with: Data(legacyPayloadJSON.utf8)) as? [String: Any])
            #expect(legacyPayload["resolvedDefaults"] == nil)

            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-approvals-get-resolved",
                    command: OpenClawSystemCommand.execApprovalsGet.rawValue,
                    paramsJSON: #"{"includeResolvedDefaults":true}"#))

            #expect(response.ok)
            let payloadJSON = try #require(response.payloadJSON)
            struct Snapshot: Decodable {
                let resolvedDefaults: ExecApprovalsResolvedDefaults
            }
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(payloadJSON.utf8))
            #expect(snapshot.resolvedDefaults.security == .full)
            #expect(snapshot.resolvedDefaults.ask == .off)
            #expect(snapshot.resolvedDefaults.askFallback == .deny)
            #expect(snapshot.resolvedDefaults.autoAllowSkills == false)

            try ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = .deny
                defaults.ask = .onMiss
                defaults.askFallback = .deny
                defaults.autoAllowSkills = false
            }.get()
            let persistedResponse = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-approvals-get-persisted",
                    command: OpenClawSystemCommand.execApprovalsGet.rawValue,
                    paramsJSON: #"{"includeResolvedDefaults":true}"#))
            #expect(persistedResponse.ok)
            let persistedPayloadJSON = try #require(persistedResponse.payloadJSON)
            let persistedSnapshot = try JSONDecoder().decode(
                Snapshot.self,
                from: Data(persistedPayloadJSON.utf8))
            #expect(persistedSnapshot.resolvedDefaults.security == .deny)
            #expect(persistedSnapshot.resolvedDefaults.ask == .onMiss)
            #expect(persistedSnapshot.resolvedDefaults.askFallback == .deny)
            #expect(persistedSnapshot.resolvedDefaults.autoAllowSkills == false)
        }
    }

    @Test func `system run denied event preserves gateway run id`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let probe = ExecEventProbe()
            let runtime = MacNodeRuntime()
            await runtime.setEventSender { event, json in
                await probe.append(event: event, json: json)
            }
            let params = OpenClawSystemRunParams(
                command: ["/bin/sh", "-lc", "printf ok"],
                rawCommand: "printf ok",
                sessionKey: "agent:main:main",
                runId: "gateway-run-1",
                approvalDecision: ExecApprovalDecision.deny.rawValue)
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-run-id",
                    command: OpenClawSystemCommand.run.rawValue,
                    paramsJSON: json))

            #expect(response.ok == false)
            let denied = try #require(await (probe.events()).first { $0.event == "exec.denied" })
            struct Payload: Decodable {
                var sessionKey: String
                var runId: String
                var command: String
            }
            let payload = try JSONDecoder().decode(Payload.self, from: Data(denied.json.utf8))
            #expect(payload.sessionKey == "agent:main:main")
            #expect(payload.runId == "gateway-run-1")
            #expect(payload.command == ExecCommandFormatter.displayString(for: params.command))
            #expect(payload.command != params.rawCommand)
        }
    }

    @Test func `handle invoke rejects blocked system run env override before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["CLASSPATH": "/tmp/evil-classpath"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2c", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("CLASSPATH") == true)
    }

    @Test func `handle invoke rejects invalid system run env override key before execution`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemRunParams(
            command: ["/bin/sh", "-lc", "echo ok"],
            env: ["BAD-KEY": "x"])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2d", command: OpenClawSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
        #expect(response.error?.message.contains("SYSTEM_RUN_DENIED: environment override rejected") == true)
        #expect(response.error?.message.contains("BAD-KEY") == true)
    }

    @Test func `handle invoke rejects empty system which`() async throws {
        let runtime = MacNodeRuntime()
        let params = OpenClawSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: OpenClawSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
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

    @Test func `handle invoke browser proxy uses injected request`() async {
        let runtime = MacNodeRuntime(
            browserProxyRequest: { paramsJSON in
                #expect(paramsJSON?.contains("/tabs") == true)
                return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
            },
            browserControlEnabled: { true })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async {
        let runtime = MacNodeRuntime(
            browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            },
            browserControlEnabled: { false })
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser-disabled",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

        #expect(response.ok == false)
        #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
    }
}
