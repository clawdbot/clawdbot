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

struct GatewayEndpointTransition {
    private var readyRevision: UInt64?

    mutating func shouldRefresh(for state: GatewayEndpointState) -> Bool {
        guard case .ready = state else {
            self.readyRevision = nil
            return false
        }
        defer { self.readyRevision = state.routeRevision }
        return self.readyRevision != state.routeRevision
    }
}

@MainActor
@Observable
final class GatewayConnectivityCoordinator {
    static let shared = GatewayConnectivityCoordinator()

    private var endpointTask: Task<Void, Never>?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var endpointTransition = GatewayEndpointTransition()
    @ObservationIgnored private var sleepCycleController: GatewaySleepCycleController?

    private(set) var endpointState: GatewayEndpointState?

    var resolvedURL: URL? {
        guard case let .ready(_, url, _, _, _) = self.endpointState else { return nil }
        return url
    }

    var resolvedMode: AppState.ConnectionMode? {
        switch self.endpointState {
        case let .ready(mode, _, _, _, _), let .connecting(mode, _, _), let .unavailable(mode, _, _): mode
        case nil: nil
        }
    }

    var resolvedHostLabel: String? {
        self.resolvedURL.map(Self.hostLabel)
    }

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
        guard state.routeRevision == GatewayEndpointStore.shared.routeRevision else { return }
        self.endpointState = state
        let shouldRefresh = self.endpointTransition.shouldRefresh(for: state)
        if case .ready = state, !shouldRefresh { return }
        ControlChannel.shared.endpointDidChange(state)
    }

    private static func hostLabel(for url: URL) -> String {
        let host = url.host ?? url.absoluteString
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }
}
