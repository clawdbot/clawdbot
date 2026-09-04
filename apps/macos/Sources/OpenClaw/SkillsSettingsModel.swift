import Observation
import OpenClawKit

@MainActor
@Observable
final class SkillsSettingsModel {
    /// Selection advances before its stream delivery; never expose the retired catalog in that gap.
    var catalog: GatewaySkillCatalog? {
        guard let loadedCatalog, self.gateway.serverLeaseMatchesCurrentState(loadedCatalog.source) else { return nil }
        return loadedCatalog
    }

    var skills: [SkillStatus] {
        self.catalog?.skills ?? []
    }

    private(set) var isLoading = false
    var error: String? {
        guard let failure else { return nil }
        let isCurrent = failure.source.map(self.gateway.serverLeaseMatchesCurrentRoute)
            ?? (failure.revision == self.gateway.selectedEndpointRevision)
        return isCurrent ? failure.message : nil
    }

    var statusMessage: String? {
        guard let status else { return nil }
        let isCurrent = status.source.map(self.gateway.serverLeaseMatchesCurrentRoute)
            ?? (status.revision == self.gateway.selectedEndpointRevision)
        return isCurrent ? status.message : nil
    }

    let gateway: GatewayConnection
    private var loadedCatalog: GatewaySkillCatalog?
    private var failure: (message: String, source: GatewayConnection.ServerLease?, revision: UInt64?)?
    private var status: (message: String, source: GatewayConnection.ServerLease?, revision: UInt64?)?
    private var source: GatewayConnection.ServerLease?
    private var busySkills: [String: GatewayConnection.ServerLease] = [:]
    private var pendingRefresh = false
    private var refreshGeneration = 0
    private var refreshTask: Task<Void, Never>?

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    isolated deinit {
        self.refreshTask?.cancel()
    }

    func run() async {
        // Subscribe first so a node invalidation cannot overtake the initial report.
        let pushes = await self.gateway.subscribe()
        self.scheduleRefresh(force: true)
        defer { self.cancelRefresh() }
        for await delivery in pushes {
            if Task.isCancelled { return }
            self.handle(delivery)
        }
    }

    func isBusy(skill: SkillStatus) -> Bool {
        self.isBusyKey(skill.skillKey)
    }

    func refresh(force: Bool = false) async {
        self.scheduleRefresh(force: force)
        await self.refreshTask?.value
    }

    private func handle(_ delivery: GatewayConnection.PushDelivery) {
        if case let .disconnected(reason) = delivery.event {
            if self.source == delivery.serverLease {
                self.cancelRefresh()
                self.source = nil
                self.loadedCatalog = nil
                // The terminal receipt owns failures after its socket invalidates pending reads.
                self.failure = delivery.isCurrent ? reason.map { ($0, delivery.serverLease, nil) } : nil
                self.status = nil
            }
            return
        }
        guard delivery.isCurrent else { return }
        if self.source != delivery.serverLease {
            self.cancelRefresh()
            self.source = delivery.serverLease
            self.loadedCatalog = nil
            self.failure = nil
            self.status = nil
            self.scheduleRefresh(force: true)
            return
        }
        switch delivery.event {
        case let .push(.event(event)) where event.event == "skills.changed":
            self.scheduleRefresh(force: true)
        case .push(.seqGap):
            self.scheduleRefresh(force: true)
        default:
            break
        }
    }

    private func cancelRefresh() {
        self.refreshGeneration += 1
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.pendingRefresh = false
        self.isLoading = false
    }

    private func scheduleRefresh(force: Bool) {
        guard force || self.catalog == nil else { return }
        self.pendingRefresh = true
        guard self.refreshTask == nil else { return }
        self.refreshGeneration += 1
        let generation = self.refreshGeneration
        self.isLoading = true
        self.refreshTask = Task {
            defer {
                if self.refreshGeneration == generation {
                    self.refreshTask = nil
                    self.isLoading = false
                }
            }
            repeat {
                self.pendingRefresh = false
                await self.load(generation: generation)
            } while !Task.isCancelled && self.refreshGeneration == generation && self.pendingRefresh
        }
    }

    private func load(generation: Int) async {
        let revision = self.gateway.selectedEndpointRevision
        var lease = self.source.flatMap { self.gateway.serverLeaseMatchesCurrentState($0) ? $0 : nil }
        self.failure = nil
        do {
            if lease == nil { lease = try await self.gateway.acquireServerLease() }
            guard let lease, !Task.isCancelled, self.refreshGeneration == generation,
                  self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            self.source = lease
            let report = try await self.gateway.skillsStatus(on: lease)
            guard !Task.isCancelled, self.refreshGeneration == generation else { return }
            self.acceptInstalledSkills(GatewaySkillCatalog(skills: report.skills, source: lease))
        } catch {
            guard !Task.isCancelled, self.refreshGeneration == generation else { return }
            let isCurrent = lease.map(self.gateway.serverLeaseMatchesCurrentRoute)
                ?? (revision == self.gateway.selectedEndpointRevision)
            if isCurrent { self.failure = (error.localizedDescription, lease, revision) }
        }
    }

    func acceptInstalledSkills(_ catalog: GatewaySkillCatalog) {
        guard self.gateway.serverLeaseMatchesCurrentState(catalog.source) else { return }
        self.source = catalog.source
        self.loadedCatalog = GatewaySkillCatalog(
            skills: catalog.skills.sorted { $0.name < $1.name }, source: catalog.source)
        self.failure = nil
    }

    func install(
        skill: SkillStatus,
        source: GatewayConnection.ServerLease,
        option: SkillInstallOption,
        target: InstallTarget) async
    {
        var destination = source
        if target == .local {
            // This button explicitly chooses the Mac; the ordinary install keeps the row's Gateway.
            if AppStateStore.shared.connectionMode != .local {
                AppStateStore.shared.connectionMode = .local
            }
            let revision = self.gateway.selectedEndpointRevision
            do {
                destination = try await self.gateway.acquireServerLease()
                guard AppStateStore.shared.connectionMode == .local else { return }
            } catch {
                self.status = (error.localizedDescription, nil, revision)
                return
            }
        }
        let targetSource = destination
        _ = await self.perform(skillKey: skill.skillKey, source: targetSource) {
            let result = try await self.gateway.skillsInstall(
                name: skill.name, installId: option.id, timeoutMs: 300_000, on: targetSource.route)
            return result.message
        }
    }

    func setEnabled(skillKey: String, enabled: Bool, source: GatewayConnection.ServerLease) async {
        _ = await self.perform(skillKey: skillKey, source: source) {
            _ = try await self.gateway.skillsUpdate(skillKey: skillKey, enabled: enabled, on: source.route)
            return enabled ? "Skill enabled" : "Skill disabled"
        }
    }

    /// Returns an error to the retained editor so a failed save keeps its typed draft visible.
    func updateEnv(
        skillKey: String,
        envKey: String,
        value: String,
        isPrimary: Bool,
        source: GatewayConnection.ServerLease) async -> String?
    {
        await self.perform(skillKey: skillKey, source: source) {
            _ = try await self.gateway.skillsUpdate(
                skillKey: skillKey,
                apiKey: isPrimary ? value : nil,
                env: isPrimary ? nil : [envKey: value],
                on: source.route)
            return "Saved \(envKey) — stored in openclaw.json (skills.entries.\(skillKey))"
        }
    }

    private func perform(
        skillKey: String,
        source: GatewayConnection.ServerLease,
        operation: () async throws -> String) async -> String?
    {
        guard self.gateway.serverLeaseMatchesCurrentRoute(source) else { return Self.sourceChangedMessage }
        guard !self.isBusyKey(skillKey) else { return "Wait for the current skill action to finish, then retry." }
        self.busySkills[skillKey] = source
        defer {
            if self.busySkills[skillKey] == source { self.busySkills.removeValue(forKey: skillKey) }
        }
        do {
            let message = try await operation()
            guard self.gateway.serverLeaseMatchesCurrentRoute(source) else { return Self.sourceChangedMessage }
            self.status = (message, source, nil)
            await self.refresh(force: true)
            return self.gateway.serverLeaseMatchesCurrentRoute(source) ? nil : Self.sourceChangedMessage
        } catch {
            guard self.gateway.serverLeaseMatchesCurrentRoute(source) else { return Self.sourceChangedMessage }
            self.status = (error.localizedDescription, source, nil)
            return error.localizedDescription
        }
    }

    private func isBusyKey(_ key: String) -> Bool {
        self.busySkills[key].map(self.gateway.serverLeaseMatchesCurrentRoute) == true
    }

    static let sourceChangedMessage =
        "The Gateway changed. Reopen this skill on the intended Gateway before saving."
}
