import Foundation
import Observation
import OpenClawKit

struct BrowserSystemProfile: Codable, Equatable {
    let browser: String
    let id: String
    let name: String
    let hasCookies: Bool

    var displayName: String {
        "\(self.browserDisplayName) — \(self.name)"
    }

    var browserDisplayName: String {
        self.browser.prefix(1).uppercased() + self.browser.dropFirst()
    }

    /// `id` is only unique per browser (Chrome and Brave both ship "Default");
    /// UI identity must span browsers or menu rows collide.
    var menuID: String {
        "\(self.browser)/\(self.id)"
    }
}

enum BrowserProfileImportDisposition: String, Codable, Equatable {
    case dismissed
    case imported
}

struct BrowserProfileImportOutcome: Codable, Equatable {
    let status: BrowserProfileImportDisposition
}

struct BrowserProfileImportStatus: Codable, Equatable {
    let enabled: Bool
    let systemProfiles: [BrowserSystemProfile]
    let state: BrowserProfileImportOutcome?
    let suggestedTarget: String

    var importableProfiles: [BrowserSystemProfile] {
        self.systemProfiles.filter(\.hasCookies)
    }
}

struct BrowserProfileImportResult: Codable, Equatable {
    struct Counts: Codable, Equatable {
        let total: Int
        let imported: Int
    }

    let into: String
    let cookies: Counts
}

struct BrowserProfileImportRequest: Equatable {
    let method: String
    let path: String
    let body: [String: AnyCodable]?
    let timeoutMs: Double?
}

/// Drives the dashboard's browser-login import banner: it mirrors the
/// gateway-persisted import state and owns the offer → import → outcome flow
/// that used to live in a modal alert.
@MainActor
@Observable
final class BrowserProfileImportModel {
    enum Phase: Equatable {
        case hidden
        case offering(BrowserProfileImportStatus)
        case importing(profile: BrowserSystemProfile, target: String)
        case imported(BrowserProfileImportResult)
        case failed(message: String, retry: BrowserProfileImportStatus)
    }

    enum ForceRefreshOutcome: Equatable {
        case offering
        case unavailable(title: String, message: String)
    }

    typealias Transport = @MainActor (BrowserProfileImportRequest) async throws -> Data

    static let shared = BrowserProfileImportModel()

    private(set) var phase: Phase = .hidden
    /// Bumped by setPhase; see refresh(force:) for the staleness contract.
    @ObservationIgnored private var phaseGeneration = 0
    /// A dismissal must stick for this app session even while its
    /// fire-and-forget persistence write is pending or lost — otherwise the
    /// next automatic poll reads the still-null server state and re-offers.
    /// Only Settings force-refresh overrides.
    @ObservationIgnored private var dismissedThisSession = false

    private let transport: Transport
    private let isOnboarded: @MainActor () -> Bool
    private let isLocalMode: @MainActor () -> Bool

    init(
        transport: @escaping Transport = BrowserProfileImportModel.gatewayTransport,
        isOnboarded: @escaping @MainActor () -> Bool = { AppStateStore.shared.onboardingSeen },
        isLocalMode: @escaping @MainActor () -> Bool = { AppStateStore.shared.connectionMode == .local })
    {
        self.transport = transport
        self.isOnboarded = isOnboarded
        self.isLocalMode = isLocalMode
    }

    static func shouldOffer(status: BrowserProfileImportStatus, force: Bool) -> Bool {
        status.enabled && !status.importableProfiles.isEmpty && (force || status.state == nil)
    }

    /// Every phase change goes through here. The generation lets an awaited
    /// status poll detect that a dismissal, import, or fresher poll happened
    /// while it was in flight — "phase is .hidden again" alone cannot tell a
    /// just-dismissed banner apart from one that never appeared.
    private func setPhase(_ phase: Phase) {
        self.phase = phase
        self.phaseGeneration += 1
    }

    /// Launch/connect/window triggers. Only fills an empty banner slot so a
    /// visible offer, in-flight import, or result is never clobbered by a
    /// background status poll.
    @discardableResult
    func refreshIfIdle() async -> Bool {
        guard !self.dismissedThisSession, case .hidden = self.phase else { return false }
        await self.refresh(force: false)
        return true
    }

    /// Force (Settings → Import…) re-offers even after a persisted dismissal
    /// and reports why nothing can be offered so the caller can tell the user.
    @discardableResult
    func refresh(force: Bool) async -> ForceRefreshOutcome {
        guard self.isOnboarded(), self.isLocalMode() else {
            self.setPhase(.hidden)
            return .unavailable(
                title: String(localized: "Browser import requires Local mode"),
                message: String(
                    localized: "Switch this Mac app to a local Gateway before importing browser cookies."))
        }
        let generation = self.phaseGeneration
        do {
            let status: BrowserProfileImportStatus = try await self.request(
                method: "GET",
                path: "/system-profile-import/status")
            // The status await interleaves with user actions. Idle polls apply
            // only if nothing changed since they started (a dismissal mid-poll
            // must stay dismissed); a forced refresh wins over everything
            // except an import that is already running.
            if force {
                if case .importing = self.phase { return .offering }
            } else {
                guard self.phaseGeneration == generation else { return .offering }
            }
            guard Self.shouldOffer(status: status, force: force) else {
                self.setPhase(.hidden)
                let message = status.enabled
                    ? String(
                        localized: "No Chrome, Brave, Edge, or Chromium profile with cookies was found on this Mac.")
                    : String(
                        localized: "System browser profile import is disabled in the local Gateway configuration.")
                return .unavailable(title: String(localized: "No browser login available"), message: message)
            }
            self.setPhase(.offering(status))
            return .offering
        } catch {
            // Same interleaving rule: a failed poll only clears state it owns.
            if force, self.phaseGeneration == generation {
                if case .importing = self.phase {} else { self.setPhase(.hidden) }
            }
            return .unavailable(
                title: String(localized: "Browser import unavailable"),
                message: error.localizedDescription)
        }
    }

    func importProfile(_ profile: BrowserSystemProfile) async {
        guard case let .offering(status) = self.phase else { return }
        self.setPhase(.importing(profile: profile, target: status.suggestedTarget))
        do {
            let body: [String: AnyCodable] = [
                "browser": AnyCodable(profile.browser),
                "systemProfile": AnyCodable(profile.id),
                "into": AnyCodable(status.suggestedTarget),
                "makeDefault": AnyCodable(true),
            ]
            let result: BrowserProfileImportResult = try await self.request(
                method: "POST",
                path: "/profiles/import",
                body: body,
                timeoutMs: 120_000)
            self.setPhase(.imported(result))
        } catch {
            self.setPhase(.failed(message: error.localizedDescription, retry: status))
        }
    }

    func retry() {
        guard case let .failed(_, status) = self.phase else { return }
        self.setPhase(.offering(status))
    }

    func dismiss() {
        let wasOffering = if case .offering = self.phase {
            true
        } else {
            false
        }
        self.setPhase(.hidden)
        // Only an unanswered offer persists the dismissal; closing a result
        // banner must not overwrite the recorded "imported" state.
        guard wasOffering else { return }
        self.dismissedThisSession = true
        Task {
            let _: [String: Bool]? = try? await self.request(
                method: "POST",
                path: "/system-profile-import/dismiss")
        }
    }

    /// Import endpoints are host-local; a remote gateway can neither list nor
    /// import system profiles, so the banner withdraws on mode switches.
    func handleConnectionModeChange() {
        guard !self.isLocalMode() else { return }
        self.setPhase(.hidden)
    }

    private func request<T: Decodable>(
        method: String,
        path: String,
        body: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> T
    {
        let data = try await self.transport(BrowserProfileImportRequest(
            method: method,
            path: path,
            body: body,
            timeoutMs: timeoutMs))
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static let gatewayTransport: Transport = { request in
        var params: [String: AnyCodable] = [
            "method": AnyCodable(request.method),
            "path": AnyCodable(request.path),
        ]
        if let body = request.body {
            params["body"] = AnyCodable(body)
        }
        return try await GatewayConnection.shared.request(
            method: "browser.request",
            params: params,
            timeoutMs: request.timeoutMs)
    }
}

#if DEBUG
extension BrowserProfileImportModel {
    func _testSetPhase(_ phase: Phase) {
        self.setPhase(phase)
    }
}
#endif
