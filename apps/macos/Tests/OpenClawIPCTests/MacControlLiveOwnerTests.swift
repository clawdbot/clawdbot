import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@MainActor
struct MacControlLiveOwnerTests {
    @Test(arguments: [AppState.ConnectionMode.unconfigured, .local, .remote], [false, true])
    func `inactive primary status suppresses stale channel errors`(mode: AppState.ConnectionMode, paused: Bool) {
        let connection = MacControlLiveOwner.primaryConnectionStatus(
            mode: mode, paused: paused, channelState: .degraded("secret"), gatewayVersion: "1.0")
        let inactive = mode == .unconfigured || paused
        #expect(connection.state == (inactive ? "disconnected" : "degraded"))
        #expect((connection.error == nil) == inactive)
        #expect(connection.error?.contains("secret") != true)
    }

    @Test(arguments: ["token", "password"])
    func `saved credentials wait for connection proof`(auth: String) async throws {
        let result = try await MacControlLiveOwner.connectSavedGateway(Self.gateway(auth: auth), deadline: nil) {
            MacControlConnectionStatus(state: "connected", gatewayVersion: "1.0")
        }
        #expect(result.id == "saved")
        #expect(result.connection.state == "connected")
        #expect(result.connection.gatewayVersion == "1.0")
        #expect(result.connection.error == nil)
    }

    @Test(arguments: ["token", "password"])
    func `connection failure retains saved profile with a safe error`(auth: String) async throws {
        let result = try await MacControlLiveOwner.connectSavedGateway(Self.gateway(auth: auth), deadline: nil) {
            throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "token secret"])
        }
        #expect(result.id == "saved")
        #expect(result.connection.state == "disconnected")
        #expect(result.connection.error != nil)
        #expect(result.connection.error?.contains("secret") == false)
    }

    @Test func `browser add keeps its validated status without another connection attempt`() async throws {
        var gateway = Self.gateway(auth: "browser")
        gateway.connection = MacControlConnectionStatus(state: "connected")
        let result = try await MacControlLiveOwner.connectSavedGateway(gateway, deadline: nil) {
            Issue.record("Browser sign-in must not acquire another lease")
            throw CancellationError()
        }
        #expect(result.connection.state == "connected")
    }

    @Test func `expired deadline retains the profile without starting a connection`() async throws {
        let result = try await MacControlLiveOwner.connectSavedGateway(
            Self.gateway(auth: "token"), deadline: .distantPast)
        {
            Issue.record("Expired add must not start a connection")
            return MacControlConnectionStatus(state: "connected")
        }
        #expect(result.id == "saved")
        #expect(result.connection.state == "disconnected")
        #expect(result.connection.error != nil)
    }

    @Test func `deadline cancels a pending connection while retaining the saved profile`() async throws {
        let result = try await MacControlLiveOwner.connectSavedGateway(
            Self.gateway(auth: "password"), deadline: Date().addingTimeInterval(0.05))
        {
            try await Task.sleep(for: .seconds(30))
            Issue.record("Connection attempt outlived its deadline")
            return MacControlConnectionStatus(state: "connected")
        }
        #expect(result.id == "saved")
        #expect(result.connection.state == "disconnected")
        #expect(result.connection.error != nil)
    }

    private static func gateway(auth: String) -> MacControlGatewayStatus {
        MacControlGatewayStatus(
            id: "saved", name: "Research", url: "wss://gateway.example/", auth: auth,
            connection: MacControlConnectionStatus(state: "disconnected"))
    }
}
