import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

struct ChatSessionRosterSnapshot: Sendable {
    let sessions: [OpenClawChatSessionEntry]
    let isCached: Bool
}

extension NodeAppModel {
    func loadChatSessionRoster(
        limit: Int,
        archived: Bool = false,
        allowCachedFallback: Bool = true) async throws -> ChatSessionRosterSnapshot
    {
        guard self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected else {
            guard allowCachedFallback else { throw URLError(.notConnectedToInternet) }
            return await ChatSessionRosterSnapshot(
                sessions: archived ? [] : self.loadCachedChatSessions(),
                isCached: true)
        }

        do {
            let response = try await self.makeChatTransport().listSessions(limit: limit, archived: archived)
            if !archived {
                self.reconcileChatSessionReadState(response.sessions)
                await self.storeCachedChatSessions(response.sessions)
            }
            return ChatSessionRosterSnapshot(sessions: response.sessions, isCached: false)
        } catch {
            guard allowCachedFallback, !archived else { throw error }
            let cached = await self.loadCachedChatSessions()
            guard !cached.isEmpty else { throw error }
            return ChatSessionRosterSnapshot(sessions: cached, isCached: true)
        }
    }
}

@MainActor
@Observable
final class RootSidebarModel {
    static let sessionLimit = 200

    struct TokenUsageSummary: Equatable {
        let total: Int?
        let isPartial: Bool
    }

    private(set) var sessions: [OpenClawChatSessionEntry] = []
    private(set) var usage: CostUsageSummaryLite?
    private(set) var cronJobs: [CronJob] = []
    private(set) var isRefreshing = false
    private(set) var sessionErrorText: String?
    private var rosterGeneration = 0
    private var dashboardGeneration = 0

    var failedCronJobCount: Int {
        self.cronJobs.count { Self.isFailedCronJob($0) }
    }

    var overdueCronJobCount: Int {
        let threshold = Int(Date().timeIntervalSince1970 * 1000) - 300_000
        return self.cronJobs.count { job in
            job.enabled && (job.nextrunatms.map { $0 < threshold } ?? false)
        }
    }

    func sections(
        query: String,
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        groups: [OpenClawChatSessionGroup]) -> [ChatSessionSidebarModel.Section]
    {
        ChatSessionSidebarModel.sections(
            sessions: self.sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            groups: groups,
            excludesMainSession: true,
            query: query)
    }

    func refresh(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.dashboardGeneration &+= 1
        let dashboardGeneration = self.dashboardGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        async let roster = self.loadRoster(appModel: appModel)
        async let dashboard = self.loadDashboard(appModel: appModel)
        let loadedRoster = await roster
        guard !Task.isCancelled else { return }
        if rosterGeneration == self.rosterGeneration {
            switch loadedRoster {
            case let .success(loadedRoster):
                self.sessions = loadedRoster.sessions
                self.sessionErrorText = nil
            case let .failure(message):
                self.sessionErrorText = message
            case .cancelled:
                return
            }
            self.isRefreshing = false
        }

        let loadedDashboard = await dashboard
        guard !Task.isCancelled, dashboardGeneration == self.dashboardGeneration else { return }
        if let usage = loadedDashboard.usage {
            self.usage = usage
        }
        if let cronJobs = loadedDashboard.cronJobs {
            self.cronJobs = cronJobs
        }
    }

    func refreshSessions(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        let loadedRoster = await self.loadRoster(appModel: appModel, allowCachedFallback: false)
        guard !Task.isCancelled, rosterGeneration == self.rosterGeneration else { return }
        switch loadedRoster {
        case let .success(roster):
            self.sessions = roster.sessions
            self.sessionErrorText = nil
        case let .failure(message):
            self.sessionErrorText = message
        case .cancelled:
            return
        }
    }

    func reportSessionError(_ error: any Error) {
        self.sessionErrorText = error.localizedDescription
    }

    static func tokenUsageSummary(for sessions: [OpenClawChatSessionEntry]) -> TokenUsageSummary {
        let knownTotals = sessions.compactMap(\.totalTokens)
        return TokenUsageSummary(
            total: knownTotals.isEmpty ? nil : knownTotals.reduce(0, +),
            isPartial: knownTotals.count < sessions.count || sessions.contains { $0.totalTokensFresh == false })
    }

    private func loadRoster(
        appModel: NodeAppModel,
        allowCachedFallback: Bool = true) async -> RosterLoadResult
    {
        do {
            return try await .success(appModel.loadChatSessionRoster(
                limit: Self.sessionLimit,
                allowCachedFallback: allowCachedFallback))
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    private func loadDashboard(appModel: NodeAppModel) async -> DashboardSnapshot {
        guard appModel.isOperatorGatewayConnected else {
            return DashboardSnapshot(usage: nil, cronJobs: nil)
        }
        async let usage = self.request(
            CostUsageSummaryLite.self,
            appModel: appModel,
            method: "usage.cost",
            paramsJSON: "{\"days\":31}")
        async let cronJobs = self.loadCronJobs(appModel: appModel)
        let loadedUsage = await usage
        let loadedCronJobs = await cronJobs
        return DashboardSnapshot(usage: loadedUsage, cronJobs: loadedCronJobs)
    }

    private func loadCronJobs(appModel: NodeAppModel) async -> [CronJob]? {
        let pageLimit = 5
        let jobLimit = 1000
        var jobs: [CronJob] = []
        var seenJobIDs: Set<String> = []
        var expectedIdentity: CronJobsSnapshotIdentity?
        var offset = 0
        for _ in 0..<pageLimit {
            let paramsJSON = "{\"includeDisabled\":true,\"limit\":200,\"offset\":\(offset)," +
                "\"sortBy\":\"name\",\"sortDir\":\"asc\"}"
            let page = await self.request(
                CronJobsListLite.self,
                appModel: appModel,
                method: "cron.list",
                paramsJSON: paramsJSON)
            guard let page,
                  let identity = cronJobsSnapshotIdentity(page: page, maximumCount: jobLimit)
            else { return nil }
            if let expectedIdentity, identity != expectedIdentity {
                return nil
            }
            expectedIdentity = identity
            let pageJobIDs = Set(page.jobs.map(\.id))
            guard pageJobIDs.count == page.jobs.count,
                  seenJobIDs.isDisjoint(with: pageJobIDs)
            else { return nil }
            seenJobIDs.formUnion(pageJobIDs)
            jobs.append(contentsOf: page.jobs)
            guard jobs.count <= jobLimit else { return nil }
            if let total = identity.total {
                guard total >= jobs.count else { return nil }
                if jobs.count == total {
                    guard !page.hasMore else { return nil }
                    return jobs
                }
            }
            guard page.hasMore else { return jobs }
            guard let nextOffset = nextCronJobsListOffset(page: page, currentOffset: offset),
                  nextOffset <= jobLimit
            else { return nil }
            offset = nextOffset
        }
        return nil
    }

    private func request<T: Decodable>(
        _ type: T.Type,
        appModel: NodeAppModel,
        method: String,
        paramsJSON: String) async -> T?
    {
        do {
            let data = try await appModel.operatorSession.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: 12)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            return nil
        }
    }

    static func isFailedCronJob(_ job: CronJob) -> Bool {
        let status = (job.lastrunstatus?.value as? String)?.lowercased()
        // This failure vocabulary mirrors the web sidebar-attention contract in ui/src/components/sidebar-attention.ts.
        return job.enabled && ["error", "failed", "timeout", "timed_out"].contains(status)
    }

    private struct DashboardSnapshot {
        let usage: CostUsageSummaryLite?
        let cronJobs: [CronJob]?
    }

    private enum RosterLoadResult {
        case success(ChatSessionRosterSnapshot)
        case failure(String)
        case cancelled
    }
}
