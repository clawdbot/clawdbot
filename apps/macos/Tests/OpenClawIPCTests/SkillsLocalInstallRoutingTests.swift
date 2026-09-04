import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct SkillsLocalInstallRoutingTests {
    @Test func `local install cannot reuse a remote endpoint while local selection is uncommitted`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try Data("""
        {"gateway":{"mode":"remote","port":49344,"auth":{"token":"synthetic-local"},
        "remote":{"transport":"direct","url":"ws://127.0.0.1:49343/","token":"synthetic-remote"}}}
        """.utf8).write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": nil,
            "OPENCLAW_GATEWAY_TOKEN": nil,
            "OPENCLAW_GATEWAY_PASSWORD": nil,
        ]) {
            var canPersist = false
            let state = AppState(preview: true, gatewayConfigSaver: { root in
                canPersist && OpenClawConfigFile.saveDict(root)
            })
            try #require(state.remoteTransport == .direct)
            state._testEnableGatewayConfigSync()
            let endpoint = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 49344 },
                localUnavailableReason: { nil },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { false },
                ensureRemoteTunnel: { throw CancellationError() },
                liveSourceIsCurrent: { source in
                    await MainActor.run { state.gatewayRoutingGeneration == source.routingGeneration }
                },
                sourceSnapshot: {
                    try await GatewayEndpointStore._testLiveSourceSnapshot(
                        state: state, profile: AppProfile(environment: [:]), beforeConfigRead: {})
                }))
            let currentURL = LockIsolated(URL(string: "ws://127.0.0.1:49343/")!)
            let installedURLs = LockIsolated<[URL]>([])
            let session = GatewayTestWebSocketSession(taskFactory: {
                let url = currentURL.value
                return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    let data: Data = switch message {
                    case let .data(data): data
                    case let .string(text): Data(text.utf8)
                    @unknown default: throw URLError(.cannotParseResponse)
                    }
                    let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                    let id = try #require(frame["id"] as? String)
                    if frame["method"] as? String == "skills.install" {
                        installedURLs.withValue { $0.append(url) }
                    }
                    socket.emitReceiveSuccess(.data(Data("""
                    {"type":"res","id":"\(id)","ok":true,
                    "payload":{"ok":true,"message":"Synthetic install recorded; no installer ran"}}
                    """.utf8)))
                })
            })
            let gateway = GatewayConnection(
                testEndpointProvider: {
                    let snapshot = try await endpoint.requireEndpoint()
                    let url = snapshot.config.url
                    currentURL.withValue { $0 = url }
                    return snapshot
                },
                currentEndpointRevision: { endpoint.routeRevision },
                sessionBox: WebSocketSessionBox(session: session))
            do {
                let remote = try await gateway.acquireServerLease()
                #expect(remote.route.url.port == 49343)
                state.connectionMode = .local
                #expect(!state.syncGatewayConfigNow())
                do {
                    _ = try await gateway.skillsInstall(name: "fixture", installId: "synthetic", on: remote.route)
                    Issue.record("An uncommitted Local selection must not install through the previous remote route")
                } catch {}
                #expect(installedURLs.value.isEmpty)

                canPersist = true
                #expect(state.syncGatewayConfigNow())
                let local = try await gateway.acquireServerLease()
                #expect(local.route.url.port == 49344)
                _ = try await gateway.skillsInstall(name: "fixture", installId: "synthetic", on: local.route)
                #expect(installedURLs.value.map(\.port) == [49344])
            } catch {
                await state._testAwaitGatewayConfigSync()
                await gateway.shutdown()
                throw error
            }
            await state._testAwaitGatewayConfigSync()
            await gateway.shutdown()
        }
    }
}
