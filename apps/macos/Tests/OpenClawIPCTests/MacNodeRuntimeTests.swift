import CoreLocation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeRuntimeTests {
    actor CanvasRefreshProbe {
        private(set) var calls = 0

        func refresh() -> String? {
            self.calls += 1
            return "http://127.0.0.1:18789/refreshed"
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

    @MainActor
    final class ScreenSnapshotProbeServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
        typealias SnapshotResult = (
            data: Data,
            format: OpenClawScreenSnapshotFormat,
            width: Int,
            height: Int)

        var snapshotCallCount = 0
        var receivedSnapshotParams: MacNodeScreenSnapshotParams?
        var snapshotResult: SnapshotResult
        var snapshotError: Error?

        init(
            snapshotResult: SnapshotResult = (Data("ok".utf8), .jpeg, 10, 10),
            snapshotError: Error? = nil)
        {
            self.snapshotResult = snapshotResult
            self.snapshotError = snapshotError
        }

        func snapshotScreen(
            screenIndex: Int?,
            maxWidth: Int?,
            quality: Double?,
            format: OpenClawScreenSnapshotFormat?) async throws -> SnapshotResult
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
            screenIndex: Int?,
            durationMs: Int?,
            fps: Double?,
            includeAudio: Bool?,
            outPath: String?) async throws -> (path: String, hasAudio: Bool)
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
    }

    @Test func `handle invoke rejects unknown command`() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func `A2UI host capability refresh uses injected node session refresher`() async {
        let probe = CanvasRefreshProbe()
        let runtime = MacNodeRuntime(
            canvasSurfaceUrl: { "http://127.0.0.1:18789/current" },
            refreshCanvasSurfaceUrl: { await probe.refresh() })

        let current = await runtime.resolveA2UIHostUrlWithCapabilityRefresh()
        #expect(current == "http://127.0.0.1:18789/current/__openclaw__/a2ui/?platform=macos")
        #expect(await probe.calls == 0)

        let refreshed = await runtime.resolveA2UIHostUrlWithCapabilityRefresh(forceRefresh: true)
        #expect(refreshed == "http://127.0.0.1:18789/refreshed/__openclaw__/a2ui/?platform=macos")
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
                sessionKey: "agent:main:main",
                runId: "gateway-run-1")
            let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-run-id",
                    command: OpenClawSystemCommand.run.rawValue,
                    paramsJSON: json))

            #expect(response.ok == false)
            let denied = try #require((await probe.events()).first { $0.event == "exec.denied" })
            struct Payload: Decodable {
                var sessionKey: String
                var runId: String
            }
            let payload = try JSONDecoder().decode(Payload.self, from: Data(denied.json.utf8))
            #expect(payload.sessionKey == "agent:main:main")
            #expect(payload.runId == "gateway-run-1")
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
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                _ = screenIndex
                _ = maxWidth
                _ = quality
                return (Data("snapshot".utf8), format ?? .jpeg, 640, 360)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
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
                CLLocation(latitude: 0, longitude: 0)
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
                -> (data: Data, format: OpenClawScreenSnapshotFormat, width: Int, height: Int)
            {
                self.snapshotCalledAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                #expect(screenIndex == 0)
                #expect(maxWidth == 800)
                #expect(quality == 0.5)
                return (Data("ok".utf8), format ?? .jpeg, 800, 450)
            }

            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
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
            var width: Int
            var height: Int
            var capturedAtMs: Int64
        }

        let payload = try JSONDecoder().decode(Payload.self, from: Data(payloadJSON.utf8))
        #expect(payload.format == "jpeg")
        #expect(payload.base64 == Data("ok".utf8).base64EncodedString())
        #expect(payload.width == 800)
        #expect(payload.height == 450)
        #expect(payload.capturedAtMs > 0)
        let snapshotCalledAtMs = await MainActor.run { services.snapshotCalledAtMs }
        #expect(snapshotCalledAtMs != nil)
        #expect(payload.capturedAtMs <= snapshotCalledAtMs!)
    }

    @Test func `handle invoke screen snapshot rejects malformed params before capture`() async throws {
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

    @Test func `handle invoke screen snapshot keeps nil params as defaults`() async throws {
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

    @Test func `handle invoke screen snapshot sanitizes capture failures`() async throws {
        struct SensitiveError: LocalizedError {
            let detail: String
            var errorDescription: String? { detail }
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

    @Test func `handle invoke screen snapshot reports validation failures as invalid request`() async throws {
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

    @Test func `handle invoke screen snapshot rejects raw payloads above base64 ceiling`() async throws {
        let payloadSize = 19_660_801
        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotResult: (
                Data(repeating: 0x41, count: payloadSize),
                .jpeg,
                4000,
                3000))
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

    @Test func `handle invoke screen snapshot rejects escaped oversized outer frames`() async throws {
        let payloadSize = 12 * 1024 * 1024
        let services = await MainActor.run {
            ScreenSnapshotProbeServices(snapshotResult: (
                Data(repeating: 0xFF, count: payloadSize),
                .png,
                4000,
                3000))
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
            ScreenSnapshotProbeServices(snapshotResult: (
                Data(repeating: 0x00, count: payloadSize),
                .jpeg,
                4000,
                3000))
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
        let runtime = MacNodeRuntime(browserProxyRequest: { paramsJSON in
            #expect(paramsJSON?.contains("/tabs") == true)
            return #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#
        })
        let paramsJSON = #"{"method":"GET","path":"/tabs","timeoutMs":2500}"#
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(
                id: "req-browser",
                command: OpenClawBrowserCommand.proxy.rawValue,
                paramsJSON: paramsJSON))

        #expect(response.ok == true)
        #expect(response.payloadJSON == #"{"result":{"ok":true,"tabs":[{"id":"tab-1"}]}}"#)
    }

    @Test func `handle invoke browser proxy rejects disabled browser control`() async throws {
        let override = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            try JSONSerialization.data(withJSONObject: ["browser": ["enabled": false]])
                .write(to: URL(fileURLWithPath: override))

            let runtime = MacNodeRuntime(browserProxyRequest: { _ in
                Issue.record("browserProxyRequest should not run when browser control is disabled")
                return "{}"
            })
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(
                    id: "req-browser-disabled",
                    command: OpenClawBrowserCommand.proxy.rawValue,
                    paramsJSON: #"{"method":"GET","path":"/tabs"}"#))

            #expect(response.ok == false)
            #expect(response.error?.message.contains("BROWSER_DISABLED") == true)
        }
    }
}
