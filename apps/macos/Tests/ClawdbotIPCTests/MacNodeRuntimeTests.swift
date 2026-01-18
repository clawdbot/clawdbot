import ClawdbotKit
import CoreLocation
import Foundation
import Testing
@testable import Clawdbot

struct MacNodeRuntimeTests {
    @Test func handleInvokeRejectsUnknownCommand() async {
        let runtime = MacNodeRuntime()
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-1", command: "unknown.command"))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptySystemRun() async throws {
        let runtime = MacNodeRuntime()
        let params = ClawdbotSystemRunParams(command: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2", command: ClawdbotSystemCommand.run.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptySystemWhich() async throws {
        let runtime = MacNodeRuntime()
        let params = ClawdbotSystemWhichParams(bins: [])
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-2b", command: ClawdbotSystemCommand.which.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeRejectsEmptyNotification() async throws {
        let runtime = MacNodeRuntime()
        let params = ClawdbotSystemNotifyParams(title: "", body: "")
        let json = try String(data: JSONEncoder().encode(params), encoding: .utf8)
        let response = await runtime.handleInvoke(
            BridgeInvokeRequest(id: "req-3", command: ClawdbotSystemCommand.notify.rawValue, paramsJSON: json))
        #expect(response.ok == false)
    }

    @Test func handleInvokeCameraListRequiresEnabledCamera() async {
        await TestIsolation.withUserDefaultsValues([cameraEnabledKey: false]) {
            let runtime = MacNodeRuntime()
            let response = await runtime.handleInvoke(
                BridgeInvokeRequest(id: "req-4", command: ClawdbotCameraCommand.list.rawValue))
            #expect(response.ok == false)
            #expect(response.error?.message.contains("CAMERA_DISABLED") == true)
        }
    }

    @Test func handleInvokeScreenRecordUsesInjectedServices() async throws {
        @MainActor
        final class FakeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
            func recordScreen(
                screenIndex: Int?,
                durationMs: Int?,
                fps: Double?,
                includeAudio: Bool?,
                outPath: String?) async throws -> (path: String, hasAudio: Bool)
            {
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("clawdbot-test-screen-record-\(UUID().uuidString).mp4")
                try Data("ok".utf8).write(to: url)
                return (path: url.path, hasAudio: false)
            }

            func locationAuthorizationStatus() -> CLAuthorizationStatus { .authorizedAlways }
            func locationAccuracyAuthorization() -> CLAccuracyAuthorization { .fullAccuracy }
            func currentLocation(
                desiredAccuracy: ClawdbotLocationAccuracy,
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
}
