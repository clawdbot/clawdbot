import Foundation
import Observation
import OpenClawKit

struct ClawHubReviewSheet: Identifiable {
    let review: ClawHubSkillInstallReview
    let source: GatewayConnection.ServerLease

    var id: String {
        "install:\(self.review.id)"
    }
}

@MainActor
@Observable
final class ClawHubSkillsBrowserModel {
    struct SearchResults {
        let skills: [ClawHubSkillSummary]
        let source: GatewayConnection.ServerLease
    }

    struct Notice {
        let title: String
        let message: String
        let warning: String?
        let isError: Bool
    }

    private struct Action: Equatable {
        let reference: String
        let source: GatewayConnection.ServerLease
    }

    var query = ""
    var searchResults: SearchResults? {
        guard let loadedResults, self.gateway.serverLeaseMatchesCurrentState(loadedResults.source) else { return nil }
        return loadedResults
    }

    var results: [ClawHubSkillSummary] {
        self.searchResults?.skills ?? []
    }

    private(set) var isSearching = false
    var reviewingSlug: String? {
        self.reviewing.flatMap { self.gateway.serverLeaseMatchesCurrentRoute($0.source) ? $0.reference : nil }
    }

    var installingSlug: String? {
        self.installing.flatMap { self.gateway.serverLeaseMatchesCurrentRoute($0.source) ? $0.reference : nil }
    }

    /// A review belongs to its configured Gateway and survives that Gateway's socket reconnects.
    var sheet: ClawHubReviewSheet? {
        get {
            guard let reviewSheet, self.gateway.serverLeaseMatchesCurrentRoute(reviewSheet.source) else { return nil }
            return reviewSheet
        }
        set { self.reviewSheet = newValue }
    }

    var notices: [Notice] {
        var notices: [Notice] = []
        if let actionNotice, self.gateway.serverLeaseMatchesCurrentRoute(actionNotice.source) {
            notices.append(actionNotice.notice)
        }
        guard let searchFailure else { return notices }
        let isCurrent = searchFailure.source.map(self.gateway.serverLeaseMatchesCurrentRoute)
            ?? (searchFailure.revision == self.gateway.selectedEndpointRevision)
        if isCurrent {
            // A later read failure does not replace the completed action or its audit warning.
            notices.append(Notice(
                title: "ClawHub unavailable", message: searchFailure.message, warning: nil, isError: true))
        }
        return notices
    }

    private let gateway: GatewayConnection
    private var reviewSheet: ClawHubReviewSheet?
    private var loadedResults: SearchResults?
    private var searchFailure: (message: String, source: GatewayConnection.ServerLease?, revision: UInt64?)?
    private var actionNotice: (notice: Notice, source: GatewayConnection.ServerLease)?
    private var source: GatewayConnection.ServerLease?
    private var searching: Task<Void, Never>?
    private var searchGeneration = 0
    private var reviewing: Action?
    private var installing: Action?

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    isolated deinit { self.searching?.cancel() }

    func run() async {
        let pushes = await self.gateway.subscribe()
        self.startSearch()
        defer { self.cancelSearch() }
        for await delivery in pushes {
            if Task.isCancelled { return }
            if let reviewSheet, !self.gateway.serverLeaseMatchesCurrentRoute(reviewSheet.source) {
                self.reviewSheet = nil
            }
            if case let .disconnected(reason) = delivery.event {
                if self.source == delivery.serverLease {
                    self.cancelSearch()
                    self.source = nil
                    self.loadedResults = nil
                    // The terminal receipt owns failures after its socket invalidates pending reads.
                    self.searchFailure = delivery.isCurrent ? reason.map { ($0, delivery.serverLease, nil) } : nil
                }
                continue
            }
            guard delivery.isCurrent, self.source != delivery.serverLease else { continue }
            self.source = delivery.serverLease
            self.loadedResults = nil
            self.startSearch()
        }
    }

    func search() async {
        self.actionNotice = nil
        self.startSearch()
        await self.searching?.value
    }

    private func cancelSearch() {
        self.searchGeneration += 1
        self.searching?.cancel()
        self.searching = nil
        self.isSearching = false
    }

    private func startSearch() {
        self.cancelSearch()
        let generation = self.searchGeneration
        self.isSearching = true
        // Catalog refreshes do not erase a completed action on this configured Gateway.
        self.searchFailure = nil
        self.searching = Task {
            defer {
                if self.searchGeneration == generation {
                    self.searching = nil
                    self.isSearching = false
                }
            }
            let revision = self.gateway.selectedEndpointRevision
            var lease = self.source.flatMap { self.gateway.serverLeaseMatchesCurrentState($0) ? $0 : nil }
            do {
                if lease == nil { lease = try await self.gateway.acquireServerLease() }
                guard let lease, !Task.isCancelled, self.searchGeneration == generation,
                      self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
                self.source = lease
                let skills = try await self.gateway.skillsSearch(query: self.query, on: lease)
                guard !Task.isCancelled, self.searchGeneration == generation,
                      self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
                self.loadedResults = SearchResults(skills: skills, source: lease)
            } catch {
                guard !Task.isCancelled, self.searchGeneration == generation else { return }
                let isCurrent = lease.map(self.gateway.serverLeaseMatchesCurrentRoute)
                    ?? (revision == self.gateway.selectedEndpointRevision)
                if isCurrent { self.searchFailure = (error.localizedDescription, lease, revision) }
            }
        }
    }

    /// Install-only sources retain the exact reference and Gateway that produced the row.
    func act(on skill: ClawHubSkillSummary, source: GatewayConnection.ServerLease) async -> GatewaySkillCatalog? {
        guard skill.canReadDetails else {
            return await self.install(ClawHubSkillInstallReview(directInstall: skill), source: source)
        }
        await self.review(skill, source: source)
        return nil
    }

    private func review(_ skill: ClawHubSkillSummary, source: GatewayConnection.ServerLease) async {
        guard self.reviewingSlug == nil, self.gateway.serverLeaseMatchesCurrentRoute(source) else { return }
        let action = Action(reference: skill.reference, source: source)
        self.reviewing = action
        self.clearNotice()
        defer { if self.reviewing == action { self.reviewing = nil } }
        do {
            let lease = try await self.readSource(for: source)
            let detail = try await self.gateway.skillsDetail(slug: skill.reference, on: lease)
            guard self.gateway.serverLeaseMatchesCurrentState(lease)
            else { throw ClawHubSkillsBrowserError.sourceChanged }
            guard let review = ClawHubSkillInstallReview(detail: detail, fallback: skill) else {
                throw ClawHubSkillsBrowserError.missingInstallVersion
            }
            self.sheet = ClawHubReviewSheet(review: review, source: lease)
        } catch {
            self.failure(title: "Could not review skill", error: error, source: source)
        }
    }

    func install(
        _ review: ClawHubSkillInstallReview,
        source: GatewayConnection.ServerLease) async -> GatewaySkillCatalog?
    {
        guard self.installingSlug == nil, self.gateway.serverLeaseMatchesCurrentRoute(source) else { return nil }
        let action = Action(reference: review.slug, source: source)
        self.installing = action
        self.clearNotice()
        defer {
            if self.installing == action { self.installing = nil }
            if self.sheet?.source == source { self.sheet = nil }
        }
        let result: SkillInstallResult
        do {
            result = try await self.gateway.skillsInstallClawHub(
                slug: review.slug, version: review.version, on: source.route)
        } catch let error as GatewayResponseError {
            let rejection = SkillManagementContract.rejection(from: error)
            self.failure(
                title: "Gateway blocked install",
                message: rejection.message,
                warning: rejection.warning,
                source: source)
            return nil
        } catch {
            // The shipped Gateway joins identical installs across reconnects; read back only on that route.
            if let catalog = try? await self.readCatalog(source: source),
               self.gateway.serverLeaseMatchesCurrentState(catalog.source),
               installedAfter(catalog.skills, review: review)
            {
                self.actionNotice = (Notice(
                    title: "Installed",
                    message: "The Gateway installed the reviewed version.",
                    warning: nil,
                    isError: false), source)
                return catalog
            }
            self.failure(title: "Install result unknown", error: error, source: source)
            return nil
        }
        // The install acknowledgement is a completed outcome. A later catalog
        // failure cannot turn it into a rejection or discard its audit warning.
        do {
            let catalog = try await self.readCatalog(source: source)
            guard self.gateway.serverLeaseMatchesCurrentState(catalog.source) else {
                throw ClawHubSkillsBrowserError.sourceChanged
            }
            guard installedAfter(catalog.skills, review: review) else {
                throw ClawHubSkillsBrowserError.installNotConfirmed
            }
            self.actionNotice = (Notice(
                title: "Installed", message: result.message, warning: result.warning, isError: false), source)
            return catalog
        } catch {
            self.failure(
                title: "Installed; refresh needed",
                message: "\(result.message)\n\n\(error.localizedDescription)\n\n" +
                    "Refresh Skills to load the installed version.",
                warning: result.warning,
                source: source)
        }
        return nil
    }

    private func readSource(for source: GatewayConnection.ServerLease) async throws -> GatewayConnection.ServerLease {
        if self.gateway.serverLeaseMatchesCurrentState(source) { return source }
        return try await self.gateway.acquireServerLease(ifSameRouteAs: source, timeoutMs: 15000)
    }

    private func readCatalog(source: GatewayConnection.ServerLease) async throws -> GatewaySkillCatalog {
        let lease = try await self.readSource(for: source)
        let report = try await self.gateway.skillsStatus(on: lease)
        guard self.gateway.serverLeaseMatchesCurrentState(lease) else { throw ClawHubSkillsBrowserError.sourceChanged }
        return GatewaySkillCatalog(skills: report.skills, source: lease)
    }

    private func failure(title: String, error: Error, source: GatewayConnection.ServerLease) {
        self.failure(title: title, message: error.localizedDescription, warning: nil, source: source)
    }

    private func failure(title: String, message: String, warning: String?, source: GatewayConnection.ServerLease) {
        guard self.gateway.serverLeaseMatchesCurrentRoute(source) else { return }
        self.actionNotice = (Notice(
            title: title,
            message: message,
            warning: warning,
            isError: true), source)
    }

    private func clearNotice() {
        self.searchFailure = nil
        self.actionNotice = nil
    }
}

/// An install-only source resolves to a commit, not a release, and its reference is not a
/// `@owner/slug` spelling, so confirmation matches the reference the Gateway recorded.
private func installedAfter(_ skills: [SkillStatus], review: ClawHubSkillInstallReview) -> Bool {
    if let requestedReference = review.requestedReference {
        return SkillManagementContract.installed(skills, requestedReference: requestedReference)
    }
    guard let version = review.version else {
        return SkillManagementContract.installed(skills, slug: review.slug)
    }
    return SkillManagementContract.installed(skills, slug: review.slug, version: version)
}

private enum ClawHubSkillsBrowserError: LocalizedError {
    case sourceChanged
    case missingInstallVersion
    case installNotConfirmed

    var errorDescription: String? {
        switch self {
        case .sourceChanged:
            "The Gateway changed. Refresh and try again."
        case .missingInstallVersion:
            "ClawHub did not report an installable version for this skill."
        case .installNotConfirmed:
            "The refreshed catalog has not reported the installed skill yet."
        }
    }
}
