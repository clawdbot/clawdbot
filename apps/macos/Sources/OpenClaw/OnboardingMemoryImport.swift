import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol

@MainActor
@Observable
final class OnboardingMemoryImportModel {
    struct Provider: Identifiable, Equatable {
        let providerId: String
        let label: String
        let source: String?
        let found: Bool
        let plannedItemIds: [String]
        let alreadyImportedCount: Int
        let planFingerprint: String?
        var selected: Bool
        var inlineError: String?
        var result: ProviderResult?
        var requiresReplan: Bool
        var appliedPlanFingerprint: String?

        var id: String {
            self.providerId
        }

        var plannedCount: Int {
            self.plannedItemIds.count
        }

        var isActionable: Bool {
            self.found && !self.requiresReplan && self.plannedCount > 0 &&
                self.appliedPlanFingerprint != self.planFingerprint &&
                self.planFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
    }

    struct ProviderResult: Identifiable, Equatable {
        let providerId: String
        let label: String
        let migrated: Int
        let skipped: Int
        let conflicts: Int
        let errors: Int

        var id: String {
            self.providerId
        }
    }

    enum Phase: Equatable {
        case idle
        case planning
        case offer([Provider])
        case empty
        case failed(String)
        case applying
        case done([ProviderResult])
    }

    private(set) var phase: Phase = .idle
    private(set) var autoAdvanceRequested = false
    private(set) var applyingProviders: [Provider] = []

    @ObservationIgnored private var operationToken = UUID()
    @ObservationIgnored private var agentId: String?
    @ObservationIgnored private var planningLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var applyIdempotencyKeys: [String: String] = [:]
    @ObservationIgnored private var replanCarryover: [String: Provider] = [:]
    @ObservationIgnored private var replanSourceLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var replanSourceAgentId: String?
    @ObservationIgnored private var replanSourceWorkspace: String?
    @ObservationIgnored private var planWorkspace: String?
    @ObservationIgnored private var pageIsActive = false
    private var failureDismissed = false

    var providers: [Provider] {
        switch self.phase {
        case let .offer(providers): providers
        case .applying: self.applyingProviders
        default: []
        }
    }

    var results: [ProviderResult] {
        if case let .done(results) = self.phase { return results }
        return []
    }

    var hasOffer: Bool {
        self.providers.contains { $0.found && $0.isActionable }
    }

    var resolvedEmpty: Bool {
        if case .empty = self.phase { return true }
        return false
    }

    var isApplying: Bool {
        if case .applying = self.phase { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self.phase { return true }
        return false
    }

    /// Empty results stay in the pager only long enough for an active page to
    /// hand off. A dismissed failure is likewise removed by the navigation owner.
    var pageEligible: Bool {
        switch self.phase {
        case .empty:
            self.autoAdvanceRequested
        case .failed:
            !self.failureDismissed
        case .idle, .planning, .offer, .applying, .done:
            true
        }
    }

    var hasSelectedProviders: Bool {
        self.providers.contains { $0.selected && $0.isActionable }
    }

    var hasReplanRequired: Bool {
        self.providers.contains(where: \.requiresReplan)
    }

    var canReplan: Bool {
        self.hasReplanRequired && self.applyIdempotencyKeys.isEmpty
    }

    var shouldStartAutomatically: Bool {
        if case .idle = self.phase { return true }
        return false
    }

    func setPageActive(_ active: Bool) {
        self.pageIsActive = active
    }

    func setSelected(_ selected: Bool, providerId: String) {
        guard case var .offer(providers) = self.phase,
              let index = providers.firstIndex(where: { $0.providerId == providerId }),
              providers[index].isActionable
        else { return }
        providers[index].selected = selected
        providers[index].inlineError = nil
        self.phase = .offer(providers)
    }

    func consumeAutoAdvanceRequest() {
        self.autoAdvanceRequested = false
        self.pageIsActive = false
    }

    func dismissFailure() {
        guard self.isFailed else { return }
        self.failureDismissed = true
        self.pageIsActive = false
    }

    func reset() {
        self.operationToken = UUID()
        self.agentId = nil
        self.planningLease = nil
        self.applyIdempotencyKeys = [:]
        self.replanCarryover = [:]
        self.replanSourceLease = nil
        self.replanSourceAgentId = nil
        self.replanSourceWorkspace = nil
        self.planWorkspace = nil
        self.phase = .idle
        self.applyingProviders = []
        self.autoAdvanceRequested = false
        self.pageIsActive = false
        self.failureDismissed = false
    }

    /// Resolve the default agent on the same physical Gateway connection used
    /// for planning, so a reconnect cannot pair one server's agent with another.
    func startPlanning(gateway: GatewayConnection) async {
        guard let token = self.beginPlanning() else { return }
        var lease: GatewayConnection.ServerLease?
        do {
            let (acquiredLease, preservedSourceRoute) = try await self.acquirePlanningLease(gateway: gateway)
            lease = acquiredLease
            let agentId = try await gateway.defaultAgentId(ifCurrentServerLease: acquiredLease)
            guard self.isCurrent(token) else { return }
            guard await gateway.isCurrentServerLease(acquiredLease) else {
                self.finishStaleLease(token: token)
                return
            }
            guard self.isCurrent(token) else { return }
            await self.discardReplanCarryoverUnlessSameTarget(
                agentId: agentId,
                preservedSourceRoute: preservedSourceRoute)
            guard self.isCurrent(token) else { return }
            self.planningLease = acquiredLease
            await self.performPlanning(
                gateway: gateway,
                agentId: agentId,
                lease: acquiredLease,
                token: token)
        } catch {
            if let lease, await !(gateway.isCurrentServerLease(lease)) {
                self.finishStaleLease(token: token)
                return
            }
            self.finishPlanningFailure(error.localizedDescription, token: token)
        }
    }

    func startPlanning(gateway: GatewayConnection, agentId: String) async {
        guard let token = self.beginPlanning() else { return }
        var lease: GatewayConnection.ServerLease?
        do {
            let (acquiredLease, preservedSourceRoute) = try await self.acquirePlanningLease(gateway: gateway)
            lease = acquiredLease
            guard self.isCurrent(token) else { return }
            guard await gateway.isCurrentServerLease(acquiredLease) else {
                self.finishStaleLease(token: token)
                return
            }
            guard self.isCurrent(token) else { return }
            await self.discardReplanCarryoverUnlessSameTarget(
                agentId: agentId,
                preservedSourceRoute: preservedSourceRoute)
            guard self.isCurrent(token) else { return }
            self.planningLease = acquiredLease
            await self.performPlanning(
                gateway: gateway,
                agentId: agentId,
                lease: acquiredLease,
                token: token)
        } catch {
            if let lease, await !(gateway.isCurrentServerLease(lease)) {
                self.finishStaleLease(token: token)
                return
            }
            self.finishPlanningFailure(error.localizedDescription, token: token)
        }
    }

    func importSelected(gateway: GatewayConnection) async {
        guard case let .offer(offeredProviders) = self.phase,
              let agentId = self.agentId,
              let lease = self.planningLease
        else { return }
        let selectedIds = Set(offeredProviders.compactMap { provider in
            provider.selected && provider.isActionable
                ? provider.providerId
                : nil
        })
        guard !selectedIds.isEmpty else { return }

        let token = UUID()
        self.operationToken = token
        self.applyingProviders = offeredProviders
        self.phase = .applying

        guard await gateway.isCurrentServerLease(lease) else {
            self.finishStaleLease(token: token)
            return
        }
        guard self.isCurrent(token) else { return }

        var providers = self.applyingProviders
        for index in providers.indices where selectedIds.contains(providers[index].providerId) {
            let outcome = await self.applyOne(
                at: index,
                providers: &providers,
                gateway: gateway,
                agentId: agentId,
                lease: lease,
                token: token)
            guard outcome == .continueBatch else { return }
        }

        guard self.isCurrent(token) else { return }
        guard await gateway.isCurrentServerLease(lease) else {
            self.finishStaleLease(token: token, applyingProviders: providers)
            return
        }
        guard self.isCurrent(token) else { return }
        let results = providers.compactMap(\.result)
        self.applyingProviders = []
        if providers.contains(where: {
            $0.inlineError != nil || (($0.result?.errors ?? 0) + ($0.result?.conflicts ?? 0)) > 0
        }) {
            self.phase = .offer(providers)
        } else {
            self.planningLease = nil
            self.applyIdempotencyKeys = [:]
            self.phase = .done(results)
        }
    }

    private enum ApplyBatchOutcome {
        case continueBatch
        case abort
    }

    /// Applies one provider's planned items; mutates its row in place. `.abort`
    /// means the operation token or server lease went stale mid-flight.
    private func applyOne(
        at index: Int,
        providers: inout [Provider],
        gateway: GatewayConnection,
        agentId: String,
        lease: GatewayConnection.ServerLease,
        token: UUID) async -> ApplyBatchOutcome
    {
        guard self.isCurrent(token) else { return .abort }
        guard await gateway.isCurrentServerLease(lease) else {
            self.finishStaleLease(token: token, applyingProviders: providers)
            return .abort
        }
        guard self.isCurrent(token) else { return .abort }
        guard let fingerprint = providers[index].planFingerprint else {
            providers[index].inlineError = "The Gateway did not return a usable import plan. Try planning again."
            return .continueBatch
        }
        let providerId = providers[index].providerId
        let idempotencyKey = self.applyIdempotencyKeys[providerId] ?? UUID().uuidString
        self.applyIdempotencyKeys[providerId] = idempotencyKey
        do {
            let data = try await gateway.request(
                method: "migrations.memory.apply",
                params: [
                    "idempotencyKey": AnyCodable(idempotencyKey),
                    "agentId": AnyCodable(agentId),
                    "providerId": AnyCodable(providerId),
                    "planFingerprint": AnyCodable(fingerprint),
                    "itemIds": AnyCodable(providers[index].plannedItemIds),
                    "overwrite": AnyCodable(false),
                ],
                timeoutMs: 120_000,
                ifCurrentServerLease: lease)
            guard self.isCurrent(token) else { return .abort }
            guard await gateway.isCurrentServerLease(lease) else {
                self.finishStaleLease(token: token, applyingProviders: providers)
                return .abort
            }
            guard self.isCurrent(token) else { return .abort }
            let result = try JSONDecoder().decode(MigrationsMemoryApplyResult.self, from: data)
            guard result.providerid == providerId else {
                throw OnboardingMemoryImportError.unexpectedApplyProvider
            }
            self.applyIdempotencyKeys.removeValue(forKey: providerId)
            Self.recordApplyResult(
                &providers[index],
                summary: result.summary,
                fingerprint: fingerprint)
        } catch {
            guard self.isCurrent(token) else { return .abort }
            guard await gateway.isCurrentServerLease(lease) else {
                self.finishStaleLease(token: token, applyingProviders: providers)
                return .abort
            }
            guard self.isCurrent(token) else { return .abort }
            // A Gateway rejection is definitive. Transport and decode
            // failures are ambiguous, so a retry must reuse the same key.
            if error is GatewayResponseError {
                self.applyIdempotencyKeys.removeValue(forKey: providerId)
                providers[index].selected = false
                providers[index].requiresReplan = true
            }
            providers[index].inlineError = error.localizedDescription
        }
        return .continueBatch
    }

    /// Conflicts mean selected items were skipped after planning (a target
    /// appeared mid-apply); they need a replan, not "done".
    private static func recordApplyResult(
        _ provider: inout Provider,
        summary: MemoryMigrationSummary,
        fingerprint: String)
    {
        provider.selected = false
        provider.result = self.mergeResult(
            provider.result,
            providerId: provider.providerId,
            label: provider.label,
            summary: summary)
        let incomplete = summary.errors + summary.conflicts
        provider.requiresReplan = incomplete > 0
        provider.appliedPlanFingerprint = incomplete == 0 ? fingerprint : nil
        provider.inlineError = incomplete > 0
            ? "\(incomplete) \(Self.memoryNoun(incomplete)) could not be imported."
            : nil
    }

    private func beginPlanning() -> UUID? {
        switch self.phase {
        case .idle:
            self.discardReplanCarryover()
        case .failed:
            break
        case let .offer(providers):
            guard self.canReplan else { return nil }
            self.replanCarryover = Dictionary(uniqueKeysWithValues: providers.map { ($0.providerId, $0) })
            self.replanSourceLease = self.planningLease
            self.replanSourceAgentId = self.agentId
            self.replanSourceWorkspace = self.planWorkspace
        case .planning, .empty, .applying, .done:
            return nil
        }
        let token = UUID()
        self.operationToken = token
        self.agentId = nil
        self.planningLease = nil
        self.planWorkspace = nil
        if self.replanCarryover.isEmpty {
            self.applyIdempotencyKeys = [:]
        }
        self.phase = .planning
        self.applyingProviders = []
        self.autoAdvanceRequested = false
        self.failureDismissed = false
        return token
    }

    private func performPlanning(
        gateway: GatewayConnection,
        agentId: String,
        lease: GatewayConnection.ServerLease,
        token: UUID) async
    {
        do {
            let data = try await gateway.request(
                method: "migrations.memory.plan",
                params: [
                    "agentId": AnyCodable(agentId),
                    "overwrite": AnyCodable(false),
                ],
                timeoutMs: 30000,
                ifCurrentServerLease: lease)
            guard self.isCurrent(token) else { return }
            guard await gateway.isCurrentServerLease(lease) else {
                self.finishStaleLease(token: token)
                return
            }
            guard self.isCurrent(token) else { return }
            let result = try JSONDecoder().decode(MigrationsMemoryPlanResult.self, from: data)
            try Self.validatePlan(result, requestedAgentId: agentId)
            if self.replanSourceWorkspace != nil,
               self.replanSourceWorkspace != result.workspace
            {
                self.discardReplanCarryoverAndPendingKeys()
            }
            let providers = self.mergeReplanCarryover(into: result.providers.map(Self.provider(from:)))
            self.agentId = agentId
            self.planWorkspace = result.workspace
            if let provider = providers.first(where: {
                $0.requiresReplan && self.applyIdempotencyKeys[$0.providerId] != nil
            }) {
                self.finishPlanningFailure(
                    provider.inlineError ?? "The Gateway could not refresh a pending memory import. Try again.",
                    token: token)
            } else if providers.contains(where: { $0.found && $0.isActionable }) {
                self.planningLease = lease
                self.discardReplanCarryover()
                self.phase = .offer(providers)
            } else if let provider = providers.first(where: { $0.inlineError != nil }),
                      let error = provider.inlineError
            {
                self.finishPlanningFailure("\(provider.label): \(error)", token: token)
            } else if !providers.compactMap(\.result).isEmpty {
                self.planningLease = nil
                self.discardReplanCarryover()
                self.phase = .done(providers.compactMap(\.result))
            } else {
                self.planningLease = nil
                self.discardReplanCarryover()
                self.phase = .empty
                self.autoAdvanceRequested = self.pageIsActive
            }
        } catch {
            guard self.isCurrent(token) else { return }
            guard await gateway.isCurrentServerLease(lease) else {
                self.finishStaleLease(token: token)
                return
            }
            guard self.isCurrent(token) else { return }
            self.finishPlanningFailure(error.localizedDescription, token: token)
        }
    }

    private static func provider(from plan: MemoryMigrationProviderPlan) -> Provider {
        let plannedItemIds = plan.items.compactMap { item in
            item.status == .planned ? item.id : nil
        }
        let fingerprint = plan.planfingerprint?.trimmingCharacters(in: .whitespacesAndNewlines)
        let usableFingerprint = fingerprint?.isEmpty == false ? fingerprint : nil
        let inconsistentFoundError = !plan.found && !plannedItemIds.isEmpty
            ? "The Gateway returned an inconsistent provider plan. Try planning again."
            : nil
        let missingFingerprintError = !plannedItemIds.isEmpty && usableFingerprint == nil
            ? "The Gateway did not return a usable import plan. Try planning again."
            : nil
        let summaryError = plan.summary.errors > 0
            ? "The Gateway could not plan \(plan.summary.errors) \(Self.memoryNoun(plan.summary.errors)). Try again."
            : nil
        let planError = plan.error ?? inconsistentFoundError ?? missingFingerprintError ?? summaryError
        return Provider(
            providerId: plan.providerid,
            label: plan.label,
            source: plan.source,
            found: plan.found,
            plannedItemIds: plannedItemIds,
            alreadyImportedCount: plan.items.count { $0.status == .conflict },
            planFingerprint: usableFingerprint,
            selected: plan.found && !plannedItemIds.isEmpty && usableFingerprint != nil && planError == nil,
            inlineError: planError,
            result: nil,
            requiresReplan: planError != nil,
            appliedPlanFingerprint: nil)
    }

    private func mergeReplanCarryover(into freshProviders: [Provider]) -> [Provider] {
        guard !self.replanCarryover.isEmpty else { return freshProviders }
        var merged = freshProviders.map { fresh -> Provider in
            guard let previous = self.replanCarryover[fresh.providerId] else { return fresh }
            let identityChanged = previous.planFingerprint != fresh.planFingerprint ||
                previous.plannedItemIds != fresh.plannedItemIds
            if identityChanged, !fresh.requiresReplan {
                self.applyIdempotencyKeys.removeValue(forKey: fresh.providerId)
            }
            var provider = fresh
            provider.result = previous.result
            provider.appliedPlanFingerprint = identityChanged ? nil : previous.appliedPlanFingerprint
            if previous.result?.errors == 0 {
                provider.selected = !provider.requiresReplan && provider.isActionable
                if !provider.requiresReplan {
                    provider.inlineError = nil
                }
            } else if previous.requiresReplan {
                if !provider.requiresReplan {
                    provider.inlineError = nil
                }
            } else {
                provider.selected = previous.selected && provider.isActionable
                provider.inlineError = identityChanged
                    ? fresh.inlineError
                    : (fresh.inlineError ?? previous.inlineError)
            }
            return provider
        }
        let mergedIds = Set(merged.map(\.providerId))
        for providerId in Array(self.applyIdempotencyKeys.keys) where !mergedIds.contains(providerId) {
            self.applyIdempotencyKeys.removeValue(forKey: providerId)
        }
        merged.append(contentsOf: self.replanCarryover.values.compactMap { previous in
            guard previous.result != nil,
                  !mergedIds.contains(previous.providerId)
            else { return nil }
            var completed = previous
            completed.selected = false
            completed.inlineError = nil
            completed.requiresReplan = false
            completed.appliedPlanFingerprint = completed.planFingerprint
            return completed
        })
        return merged
    }

    private func acquirePlanningLease(
        gateway: GatewayConnection) async throws -> (GatewayConnection.ServerLease, Bool)
    {
        if let sourceLease = self.replanSourceLease {
            let lease = try await gateway.acquireServerLease(
                ifSameRouteAs: sourceLease,
                timeoutMs: 15000)
            return (lease, true)
        }
        return try await (gateway.acquireServerLease(), false)
    }

    private func discardReplanCarryoverUnlessSameTarget(
        agentId: String,
        preservedSourceRoute: Bool) async
    {
        guard !self.replanCarryover.isEmpty else { return }
        guard self.replanSourceAgentId == agentId,
              preservedSourceRoute
        else {
            self.discardReplanCarryoverAndPendingKeys()
            return
        }
    }

    private func discardReplanCarryover() {
        self.replanCarryover = [:]
        self.replanSourceLease = nil
        self.replanSourceAgentId = nil
        self.replanSourceWorkspace = nil
    }

    private func discardReplanCarryoverAndPendingKeys() {
        self.discardReplanCarryover()
        self.applyIdempotencyKeys = [:]
    }

    private static func mergeResult(
        _ previous: ProviderResult?,
        providerId: String,
        label: String,
        summary: MemoryMigrationSummary) -> ProviderResult
    {
        ProviderResult(
            providerId: providerId,
            label: label,
            migrated: (previous?.migrated ?? 0) + summary.migrated,
            skipped: (previous?.skipped ?? 0) + summary.skipped,
            conflicts: (previous?.conflicts ?? 0) + summary.conflicts,
            errors: summary.errors)
    }

    private static func validatePlan(
        _ result: MigrationsMemoryPlanResult,
        requestedAgentId: String) throws
    {
        guard result.agentid == requestedAgentId else {
            throw OnboardingMemoryImportError.unexpectedPlanAgent
        }
        var providerIds = Set<String>()
        for provider in result.providers {
            let providerId = provider.providerid.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !providerId.isEmpty,
                  providerId == provider.providerid,
                  providerIds.insert(providerId).inserted
            else {
                throw OnboardingMemoryImportError.invalidProviderIdentity
            }
        }
    }

    private func finishPlanningFailure(_ message: String, token: UUID) {
        guard self.isCurrent(token) else { return }
        self.agentId = nil
        self.planningLease = nil
        self.planWorkspace = nil
        if self.replanCarryover.isEmpty {
            self.applyIdempotencyKeys = [:]
        }
        self.phase = .failed(message)
    }

    private func finishStaleLease(
        token: UUID,
        applyingProviders currentProviders: [Provider]? = nil)
    {
        guard self.isCurrent(token) else { return }
        if let currentProviders {
            self.applyingProviders = currentProviders
        }
        if !self.applyingProviders.isEmpty {
            self.replanCarryover = Dictionary(uniqueKeysWithValues: self.applyingProviders.map {
                ($0.providerId, $0)
            })
            self.replanSourceLease = self.planningLease
            self.replanSourceAgentId = self.agentId
            self.replanSourceWorkspace = self.planWorkspace
        } else if self.replanCarryover.isEmpty {
            self.discardReplanCarryover()
            self.applyIdempotencyKeys = [:]
        } else if let planningLease = self.planningLease {
            self.replanSourceLease = planningLease
        }
        self.agentId = nil
        self.planningLease = nil
        self.planWorkspace = nil
        self.applyingProviders = []
        self.phase = .failed("The Gateway reconnected while checking memories. Try again.")
    }

    private static func memoryNoun(_ count: Int) -> String {
        count == 1 ? "memory" : "memories"
    }

    private func isCurrent(_ token: UUID) -> Bool {
        self.operationToken == token && !Task.isCancelled
    }
}

private struct DefaultAgentIdResult: Decodable {
    let defaultId: String
}

extension GatewayConnection {
    func defaultAgentId(ifCurrentServerLease lease: ServerLease) async throws -> String {
        let data = try await self.request(
            method: "agents.list",
            params: [:],
            timeoutMs: 15000,
            ifCurrentServerLease: lease)
        guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
        let result = try JSONDecoder().decode(DefaultAgentIdResult.self, from: data)
        let id = result.defaultId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            throw OnboardingMemoryImportError.missingDefaultAgent
        }
        return id
    }
}

private enum OnboardingMemoryImportError: LocalizedError {
    case missingDefaultAgent
    case unexpectedPlanAgent
    case invalidProviderIdentity
    case unexpectedApplyProvider

    var errorDescription: String? {
        switch self {
        case .missingDefaultAgent:
            "The Gateway did not report a default agent for memory import."
        case .unexpectedPlanAgent:
            "The Gateway returned a memory plan for a different agent. Try again."
        case .invalidProviderIdentity:
            "The Gateway returned an invalid memory provider plan. Try again."
        case .unexpectedApplyProvider:
            "The Gateway returned a result for a different memory provider. Try again."
        }
    }
}
