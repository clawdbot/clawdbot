import AppKit
import Foundation
import Observation
import OpenClawProtocol
import OSLog

private let gatewayConnectivityLogger = Logger(
    subsystem: "ai.openclaw",
    category: "gateway.connectivity")

private struct GatewaySleepPrepareResponse: Decodable {
    let status: String
    let suspensionId: String?
}

@MainActor
@Observable
final class GatewayConnectivityCoordinator {
    static let shared = GatewayConnectivityCoordinator()

    private var endpointTask: Task<Void, Never>?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var lastResolvedURL: URL?
    private var lastRouteRevision: UInt64?
    @ObservationIgnored private var sleepCycleController: GatewaySleepCycleController?

    private(set) var endpointState: GatewayEndpointState?
    private(set) var resolvedURL: URL?
    private(set) var resolvedMode: AppState.ConnectionMode?
    private(set) var resolvedHostLabel: String?

    private init() {
        self.sleepCycleController = GatewaySleepCycleController(
            requestID: "macos-sleep-\(UUID().uuidString.lowercased())",
            // Route tokens and the shared RPC connection both follow the endpoint
            // store; a switch between the two reads fails conservatively — the wake
            // path drops a mismatched lease and lets it self-expire.
            currentRoute: { [weak self] in
                guard case let .ready(_, url, _, _, _) = self?.endpointState else { return nil }
                return url.absoluteString
            },
            prepare: { requestID in
                let data = try await GatewayConnection.shared.request(
                    method: "gateway.suspend.prepare",
                    params: ["requestId": AnyCodable(requestID)],
                    timeoutMs: 3000,
                    retryTransportFailures: false)
                let response = try JSONDecoder().decode(GatewaySleepPrepareResponse.self, from: data)
                guard response.status == "ready", let suspensionID = response.suspensionId else {
                    return .busy
                }
                return .ready(suspensionID: suspensionID)
            },
            resume: { suspensionID in
                _ = try await GatewayConnection.shared.request(
                    method: "gateway.suspend.resume",
                    params: ["suspensionId": AnyCodable(suspensionID)],
                    timeoutMs: 3000,
                    retryTransportFailures: false)
            },
            refresh: { await GatewayEndpointStore.shared.refresh() },
            log: { message in gatewayConnectivityLogger.error("\(message, privacy: .public)") })
        self.start()
    }

    func start() {
        guard self.endpointTask == nil else { return }
        self.registerSleepWakeObservers()
        self.endpointTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayEndpointStore.shared.subscribe()
            for await state in stream {
                await MainActor.run { self.handleEndpointState(state) }
            }
        }
    }

    private func registerSleepWakeObservers() {
        let center = NSWorkspace.shared.notificationCenter
        self.workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main)
        { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let sleepCycleController = self.sleepCycleController else { return }
                await sleepCycleController.willSleep(mode: self.resolvedMode)
            }
        })
        self.workspaceObservers.append(center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main)
        { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let sleepCycleController = self.sleepCycleController else { return }
                await sleepCycleController.didWake(mode: self.resolvedMode)
            }
        })
    }

    var localEndpointHostLabel: String? {
        guard self.resolvedMode == .local, let url = resolvedURL else { return nil }
        return Self.hostLabel(for: url)
    }

    private func handleEndpointState(_ state: GatewayEndpointState) {
        self.endpointState = state
        switch state {
        case let .ready(mode, url, _, _, routeRevision):
            self.resolvedMode = mode
            self.resolvedURL = url
            self.resolvedHostLabel = Self.hostLabel(for: url)
            let routeChanged = self.lastResolvedURL?.absoluteString != url.absoluteString ||
                self.lastRouteRevision != routeRevision
            if routeChanged {
                self.lastResolvedURL = url
                self.lastRouteRevision = routeRevision
                Task { await ControlChannel.shared.refreshEndpoint(reason: "endpoint changed") }
            }
        case let .connecting(mode, _):
            self.resolvedMode = mode
        case let .unavailable(mode, _):
            self.resolvedMode = mode
        }
    }

    private static func hostLabel(for url: URL) -> String {
        let host = url.host ?? url.absoluteString
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }
}
