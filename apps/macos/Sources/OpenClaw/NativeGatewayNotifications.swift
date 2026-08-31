import AppKit
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog
@preconcurrency import UserNotifications

@MainActor
final class NativeGatewayNotifications: NSObject {
    static let shared = NativeGatewayNotifications()
    static let statusDidChange = Notification.Name("OpenClawGatewayNotificationStatusDidChange")
    private static let identifierPrefix = "openclaw.gateway."
    private static let processPrefix = identifierPrefix + UUID().uuidString + "."
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway.notifications")

    @MainActor fileprivate final class Source {
        let target: DashboardGatewayTarget
        let connection: GatewayConnection
        var observer: Task<Void, Never>?
        var session: Session?
        var supported = false
        var retirement: Task<Void, Never>?

        init(target: DashboardGatewayTarget, connection: GatewayConnection) {
            self.target = target
            self.connection = connection
        }
    }

    @MainActor fileprivate final class Session {
        let lease: GatewayConnection.ServerLease
        let prefix = NativeGatewayNotifications.processPrefix + UUID().uuidString + "."
        var retired = false
        var enabled: Bool
        var streamTask: Task<Void, Never>?
        var deliveryTask: Task<Void, Never>?
        let deliveries = AsyncStream<Claim>.makeStream(bufferingPolicy: .bufferingNewest(200))
        var ready: Task<[String: AnyCodable], Error>?
        var claims: [String: Claim] = [:]
        var error: String?

        init(lease: GatewayConnection.ServerLease, enabled: Bool) {
            self.lease = lease
            self.enabled = enabled
        }
    }

    @MainActor fileprivate final class Claim {
        let presentation: GatewayNativeNotification.Presentation
        let identifier: String
        var expiration: Task<Void, Never>?

        init(presentation: GatewayNativeNotification.Presentation, prefix: String) {
            self.presentation = presentation
            self.identifier = prefix + UUID().uuidString
        }
    }

    struct Status {
        let supported: Bool
        let preferences: [String: AnyCodable]?
        let error: String?
        let errorRevision: UInt64
    }

    struct Binding: Sendable {
        fileprivate let source: Source
        fileprivate let session: Session
    }

    enum ConnectionError: LocalizedError {
        case unavailable
        case unsupported

        var errorDescription: String? {
            switch self {
            case .unavailable: "Connect to this Gateway and try again."
            case .unsupported: "Update this Gateway to use native notifications and notification preferences."
            }
        }
    }

    private var sources: [DashboardGatewayTarget: Source] = [:]
    private var routeObservers: [NSObjectProtocol] = []
    private var lifecycle: UInt64 = 0
    private var running = false
    private var allowedTargets: Set<DashboardGatewayTarget>?
    private var errorRevision: UInt64 = 0

    func isCurrent(_ binding: Binding, target: DashboardGatewayTarget) -> Bool {
        binding.source.target == target && self.sources[target] === binding.source &&
            binding.source.session === binding.session && !binding.session.retired
    }

    func beginAttempt(binding: Binding) {
        guard self.isCurrent(binding, target: binding.source.target) else { return }
        binding.session.error = nil
        self.errorRevision &+= 1
    }

    func start() {
        guard PermissionManager.notificationCenterAvailable, self.routeObservers.isEmpty else { return }
        self.running = true
        UNUserNotificationCenter.current().delegate = self
        self.routeObservers = [MacGatewayProfileStore.didChangeNotification, .openclawConfigDidChange].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    for source in Array(self.sources.values) {
                        if let session = source.session,
                           await !(source.connection.isCurrentServerLease(session.lease))
                        {
                            self.retire(session)
                        }
                        await self.refresh(target: source.target)
                    }
                }
            }
        }
        // A previous process cannot retain a live socket subscription. Remove only
        // our delivered items; node, pairing, and other app notifications survive.
        Task {
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications()
            let identifiers = delivered.map(\.request.identifier).filter {
                $0.hasPrefix(Self.identifierPrefix) && !$0.hasPrefix(Self.processPrefix)
            }
            center.removeDeliveredNotifications(withIdentifiers: identifiers)
            await self.refresh(target: .primary)
        }
    }

    func stop() {
        self.running = false
        self.lifecycle &+= 1
        for observer in self.routeObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        self.routeObservers.removeAll()
        for source in self.sources.values {
            source.observer?.cancel()
            self.retire(source.session)
        }
        self.sources.removeAll()
    }

    func updateTargets(_ entries: [DashboardGatewayEntry]) {
        let targets = Set(entries.compactMap { DashboardGatewayTarget(bridgeID: $0.id) })
        self.allowedTargets = targets
        for source in Array(self.sources.values) where !targets.contains(source.target) {
            guard let session = source.session, !session.retired else {
                if source.retirement == nil {
                    source.observer?.cancel()
                    self.sources[source.target] = nil
                }
                continue
            }
            self.retire(session)
            source.retirement = Task {
                _ = try? await source.connection.request(
                    method: "notifications.unsubscribe",
                    params: [:],
                    timeoutMs: 10000,
                    ifCurrentServerLease: session.lease)
                if self.allowedTargets?.contains(source.target) == false, self.sources[source.target] === source {
                    source.observer?.cancel()
                    self.sources[source.target] = nil
                }
            }
        }
    }

    func refresh(target: DashboardGatewayTarget) async {
        _ = try? await self.status(binding: self.bind(target: target))
    }

    func bind(target: DashboardGatewayTarget) async throws -> Binding {
        let source = try await self.source(for: target)
        let enabled = await PermissionManager.ensureNotifications(interactive: false)
        let session = try await self.session(for: source, enabled: enabled)
        return Binding(source: source, session: session)
    }

    func status(binding: Binding, isCurrent: @MainActor () -> Bool = { true }) async -> Status {
        let source = binding.source
        let session = binding.session
        do {
            let preferences = try await self.perform(
                binding: binding, method: "notifications.preferences.get", isCurrent: isCurrent)
            return Status(
                supported: true, preferences: preferences, error: session.error, errorRevision: self.errorRevision)
        } catch {
            if error as? MacGatewayProfileError == .profileNotFound,
               self.sources[source.target] === source, source.session === session
            {
                source.observer?.cancel()
                self.retire(source.session)
                self.sources[source.target] = nil
            }
            return Status(
                supported: source.supported,
                preferences: nil,
                error: session.error ?? error.localizedDescription,
                errorRevision: self.errorRevision)
        }
    }

    func perform(
        binding: Binding,
        method: String,
        params: [String: AnyCodable] = [:],
        isCurrent: @MainActor () -> Bool) async throws -> [String: AnyCodable]
    {
        let source = binding.source
        let session = binding.session
        let enabled = await PermissionManager.ensureNotifications(interactive: false, isCurrent: isCurrent)
        _ = try await session.ready?.value
        if session.enabled != enabled {
            let preferences = try await self.request(
                "notifications.subscribe",
                params: ["enabled": AnyCodable(enabled)],
                source: source,
                session: session,
                isCurrent: isCurrent)
            session.enabled = enabled
            if method == "notifications.preferences.get" { return preferences }
        }
        return try await self.request(
            method, params: params, source: source, session: session, isCurrent: isCurrent)
    }

    private func source(for target: DashboardGatewayTarget) async throws -> Source {
        guard self.running, self.allowedTargets?.contains(target) != false else { throw ConnectionError.unavailable }
        let lifecycle = self.lifecycle
        let connection: GatewayConnection = switch target {
        case .primary: .shared
        case let .profile(id): await MacGatewayConnectionFleet.shared.connection(profileID: id)
        }
        guard self.running, self.lifecycle == lifecycle, self.allowedTargets?.contains(target) != false else {
            throw ConnectionError.unavailable
        }
        if let source = self.sources[target] {
            if source.connection === connection { return source }
            // Fleet retirement replaces the actor as well as its socket. Never
            // revive a removed profile connection through a retained subscriber.
            source.observer?.cancel()
            self.retire(source.session)
        }
        let source = Source(target: target, connection: connection)
        self.sources[target] = source
        source.observer = Task { [weak self, weak source] in
            let stream = await connection.subscribe()
            for await push in stream {
                guard let self, let source, !Task.isCancelled else { return }
                guard case .snapshot = push else { continue }
                let enabled = await PermissionManager.ensureNotifications(interactive: false)
                do {
                    let session = try await self.session(for: source, enabled: enabled)
                    _ = try await session.ready?.value
                } catch {
                    self.logger
                        .debug("notification subscription unavailable: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        return source
    }

    private func session(for source: Source, enabled: Bool) async throws -> Session {
        await source.retirement?.value
        try Task.checkCancellation()
        guard self.sources[source.target] === source, self.allowedTargets?.contains(source.target) != false else {
            throw ConnectionError.unavailable
        }
        if let session = source.session, !session.retired,
           await source.connection.isCurrentServerLease(session.lease),
           source.session === session, !session.retired
        {
            return session
        }
        // A saved-profile dashboard may have no Swift chat window. Establish its
        // existing route without invoking primary-Gateway recovery or provisioning.
        if await source.connection.captureServerLease() == nil {
            _ = try await source.connection.request(
                method: "health", params: nil, timeoutMs: 10000, retryTransportFailures: false)
        }
        guard let lease = await source.connection.captureServerLease(), self.sources[source.target] === source else {
            throw ConnectionError.unavailable
        }
        try Task.checkCancellation()
        if let session = source.session, !session.retired,
           session.lease.socketGeneration == lease.socketGeneration, session.lease.route == lease.route
        {
            return session
        }
        self.retire(source.session)
        let session = Session(lease: lease, enabled: enabled)
        source.session = session
        session.ready = Task {
            do {
                await self.listen(source: source, session: session)
                let supported = await source.connection.supportsServerMethod(
                    "notifications.subscribe", ifCurrentServerLease: lease) == true
                guard source.session === session, !session.retired else { throw ConnectionError.unavailable }
                source.supported = supported
                guard supported else { throw ConnectionError.unsupported }
                return try await self.request(
                    "notifications.subscribe",
                    params: ["enabled": AnyCodable(enabled)],
                    source: source,
                    session: session)
            } catch {
                // Failed registration cannot own future attempts. Retire once;
                // the next caller may register again without a reconnect loop.
                self.retire(session)
                throw error
            }
        }
        return session
    }

    private func listen(source: Source, session: Session) async {
        // Register before the RPC: pending approval replay may precede its response.
        let stream = await source.connection.subscribe(bufferingNewest: 200, ifCurrentServerLease: session.lease)
        session.deliveryTask = Task {
            for await claim in session.deliveries.stream {
                guard !Task.isCancelled, !session.retired else { return }
                await self.show(claim, source: source, session: session)
            }
        }
        session.streamTask = Task { [weak self, weak source, weak session] in
            for await push in stream {
                guard let self, let source, let session, !Task.isCancelled, !session.retired else { return }
                switch push {
                case let .event(event) where event.event == "notification":
                    guard let payload = event.payload else { continue }
                    do {
                        let data = try JSONEncoder().encode(payload)
                        let notification = try JSONDecoder().decode(GatewayNativeNotification.self, from: data)
                        // Terminal and replacement events revoke authority at ingress,
                        // while an older OS add or click may still be suspended.
                        let claim: Claim
                        switch notification {
                        case let .remove(id):
                            self.remove(id, session: session)
                            continue
                        case let .show(presentation):
                            self.remove(presentation.id, session: session)
                            claim = Claim(presentation: presentation, prefix: session.prefix)
                            session.claims[presentation.id] = claim
                            claim.expiration = Task {
                                let delay = max(
                                    0,
                                    Double(presentation.expiresAtMs) / 1000 - Date().timeIntervalSince1970)
                                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                                if session.claims[presentation.id] === claim {
                                    self.remove(presentation.id, session: session)
                                }
                            }
                        }
                        switch session.deliveries.continuation.yield(claim) {
                        case .enqueued: break
                        case .dropped, .terminated:
                            self.logger.warning("notification delivery overflow; reconciling pending requests")
                            await self.finishStream(source: source, session: session)
                            return
                        @unknown default:
                            await self.finishStream(source: source, session: session)
                            return
                        }
                    } catch {
                        self.logger
                            .error("invalid Gateway notification: \(error.localizedDescription, privacy: .public)")
                    }
                case let .event(event) where event.event == "users.prefs.changed":
                    let binding = Binding(source: source, session: session)
                    guard self.isCurrent(binding, target: source.target) else { continue }
                    // The Gateway targets the authenticated profile. Refresh through
                    // this exact lease; never resolve a new target from the payload.
                    NotificationCenter.default.post(name: Self.statusDidChange, object: binding)
                case .seqGap:
                    await self.finishStream(source: source, session: session)
                    return
                default: break
                }
            }
            if let self, let source, let session { await self.finishStream(source: source, session: session) }
        }
    }

    private func finishStream(source: Source, session: Session) async {
        guard !session.retired else { return }
        // Clearing our own handle avoids cancelling the reconciliation task.
        // A live lease after stream termination means overflow, not disconnect.
        session.streamTask = nil
        self.retire(session)
        guard !Task.isCancelled, await source.connection.isCurrentServerLease(session.lease) else { return }
        await self.refresh(target: source.target)
    }

    private func request(
        _ method: String,
        params: [String: AnyCodable],
        source: Source,
        session: Session,
        isCurrent: @MainActor () -> Bool = { true }) async throws -> [String: AnyCodable]
    {
        try Task.checkCancellation()
        guard isCurrent(), self.sources[source.target] === source, source.session === session, !session.retired else {
            throw ConnectionError.unavailable
        }
        let data = try await source.connection.request(
            method: method, params: params, timeoutMs: 10000, ifCurrentServerLease: session.lease)
        guard isCurrent(), self.sources[source.target] === source, source.session === session, !session.retired else {
            throw ConnectionError.unavailable
        }
        return try JSONDecoder().decode([String: AnyCodable].self, from: data)
    }

    private func isCurrent(_ claim: Claim, source: Source, session: Session) -> Bool {
        self.sources[source.target] === source && source.session === session && !session.retired &&
            session.claims[claim.presentation.id] === claim &&
            Double(claim.presentation.expiresAtMs) > Date().timeIntervalSince1970 * 1000
    }

    private func show(_ claim: Claim, source: Source, session: Session) async {
        guard PermissionManager.notificationCenterAvailable, self.isCurrent(claim, source: source, session: session)
        else { return }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard PermissionManager.isNotificationAuthorized(status: settings.authorizationStatus),
              await source.connection.isCurrentServerLease(session.lease),
              self.isCurrent(claim, source: source, session: session), !Task.isCancelled
        else { return }
        let presentation = claim.presentation
        let content = UNMutableNotificationContent()
        content.title = presentation.title
        content.body = presentation.body
        content.interruptionLevel = presentation.alert ? .active : .passive
        do {
            try await center.add(UNNotificationRequest(identifier: claim.identifier, content: content, trigger: nil))
            // Each presentation owns its native ID, even within one socket lease.
            // Late OS completion cannot restore it or remove its replacement.
            guard await source.connection.isCurrentServerLease(session.lease),
                  self.isCurrent(claim, source: source, session: session), !Task.isCancelled
            else {
                center.removeDeliveredNotifications(withIdentifiers: [claim.identifier])
                return
            }
        } catch {
            guard await source.connection.isCurrentServerLease(session.lease),
                  self.isCurrent(claim, source: source, session: session) else { return }
            self.remove(presentation.id, session: session)
            self.logger.error("native notification failed: \(error.localizedDescription, privacy: .public)")
            session.error = "Could not show the notification. Check OpenClaw in System Settings and send another test."
            self.errorRevision &+= 1
            NotificationCenter.default.post(
                name: Self.statusDidChange, object: Binding(source: source, session: session))
        }
    }

    private func remove(_ id: String, session: Session) {
        guard let claim = session.claims.removeValue(forKey: id) else { return }
        claim.expiration?.cancel()
        guard PermissionManager.notificationCenterAvailable else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [claim.identifier])
    }

    private func retire(_ session: Session?) {
        guard let session, !session.retired else { return }
        session.retired = true
        session.streamTask?.cancel()
        session.deliveries.continuation.finish()
        session.deliveryTask?.cancel()
        session.ready?.cancel()
        for id in Array(session.claims.keys) {
            self.remove(id, session: session)
        }
    }

    private func open(identifier: String) async {
        for source in self.sources.values {
            guard let session = source.session, !session.retired, identifier.hasPrefix(session.prefix),
                  let claim = session.claims.values.first(where: { $0.identifier == identifier }),
                  let location = GatewayNativeNotification.location(claim.presentation.path),
                  await source.connection.isCurrentServerLease(session.lease),
                  self.isCurrent(claim, source: source, session: session)
            else { continue }
            await DashboardManager.shared.showNotification(
                target: source.target,
                path: location.path,
                search: location.search,
                connection: source.connection,
                lease: session.lease,
                isCurrent: { self.isCurrent(claim, source: source, session: session) })
            return
        }
    }

    private func presentationOptions(identifier: String) -> UNNotificationPresentationOptions {
        for source in self.sources.values {
            guard let session = source.session, !session.retired, identifier.hasPrefix(session.prefix),
                  let claim = session.claims.values.first(where: { $0.identifier == identifier }),
                  self.isCurrent(claim, source: source, session: session)
            else { continue }
            return claim.presentation.alert ? [.banner, .list] : [.list]
        }
        return []
    }
}

extension NativeGatewayNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification) async -> UNNotificationPresentationOptions
    {
        await self.presentationOptions(identifier: notification.request.identifier)
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async
    {
        let identifier = response.notification.request.identifier
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        await self.open(identifier: identifier)
    }
}
