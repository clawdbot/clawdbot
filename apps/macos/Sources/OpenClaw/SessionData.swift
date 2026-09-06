import Foundation
import OpenClawChatUI

struct SessionTokenStats {
    let total: Int
    let contextTokens: Int

    var percentUsed: Int? {
        guard self.contextTokens > 0, self.total > 0 else { return nil }
        return min(100, Int(round((Double(self.total) / Double(self.contextTokens)) * 100)))
    }
}

struct SessionRow: Identifiable {
    let id: String
    let key: String
    let kind: SessionKind
    let displayName: String?
    let updatedAt: Date?
    let sessionId: String?
    let thinkingLevel: String?
    let verboseLevel: String?
    let tokens: SessionTokenStats
    var color: String?

    var label: String {
        self.displayName ?? self.key
    }
}

enum SessionKind: String {
    case cron, direct, group, global, unknown

    static func from(_ entry: OpenClawChatSessionEntry) -> SessionKind {
        if entry.classification == cron.rawValue { return .cron }
        return entry.kind.flatMap(Self.init(rawValue:)) ?? .unknown
    }
}

struct SessionDefaults {
    let model: String
    let contextTokens: Int
}

enum SessionLoadError: LocalizedError {
    case gatewayUnavailable(String)
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case let .gatewayUnavailable(reason):
            "Could not reach the gateway for sessions: \(reason)"

        case let .decodeFailed(reason):
            "Could not decode gateway session payload: \(reason)"
        }
    }
}

struct SessionStoreSnapshot {
    let storePath: String
    let defaults: SessionDefaults
    let rows: [SessionRow]
}

@MainActor
enum SessionLoader {
    static let fallbackModel = "claude-opus-4-6"
    static let fallbackContextTokens = 200_000

    static let defaultStorePath = standardize(
        OpenClawPaths.stateDirURL
            .appendingPathComponent("sessions/sessions.json").path)

    static func loadSnapshot(
        activeMinutes: Int? = nil,
        limit: Int? = nil,
        includeGlobal: Bool = true,
        includeUnknown: Bool = true) async throws -> SessionStoreSnapshot
    {
        let data: Data
        do {
            let request = OpenClawChatGatewayRequests.sessionsList(
                limit: limit,
                search: nil,
                archived: false,
                includeGlobal: includeGlobal,
                includeUnknown: includeUnknown,
                activeMinutes: activeMinutes)
            data = try await ControlChannel.shared.request(request)
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if msg.localizedCaseInsensitiveContains("unknown method: sessions.list") {
                throw SessionLoadError.gatewayUnavailable(
                    "Gateway is too old (missing sessions.list). Restart/update the gateway.")
            }
            throw SessionLoadError.gatewayUnavailable(msg)
        }

        let decoded: OpenClawChatSessionsListResponse
        do {
            decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        } catch {
            throw SessionLoadError.decodeFailed(error.localizedDescription)
        }
        guard let storePath = decoded.path else {
            throw SessionLoadError.decodeFailed("Missing session store path.")
        }

        let defaults = SessionDefaults(
            model: decoded.defaults?.model ?? self.fallbackModel,
            contextTokens: decoded.defaults?.contextTokens ?? self.fallbackContextTokens)

        let rows = decoded.sessions.map { entry -> SessionRow in
            let updated = entry.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
            let input = entry.inputTokens ?? 0
            let output = entry.outputTokens ?? 0
            let total = entry.totalTokens ?? input + output
            let context = entry.contextTokens ?? defaults.contextTokens

            return SessionRow(
                id: entry.key,
                key: entry.key,
                kind: SessionKind.from(entry),
                displayName: entry.displayName,
                updatedAt: updated,
                sessionId: entry.sessionId,
                thinkingLevel: entry.thinkingLevel,
                verboseLevel: entry.verboseLevel,
                tokens: SessionTokenStats(
                    total: total,
                    contextTokens: context),
                color: entry.color)
        }.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }

        return SessionStoreSnapshot(storePath: storePath, defaults: defaults, rows: rows)
    }

    private static func standardize(_ path: String) -> String {
        (path as NSString).expandingTildeInPath.replacingOccurrences(of: "//", with: "/")
    }
}

func relativeAge(from date: Date?, now: Date = Date()) -> String {
    guard let date else { return "unknown" }
    let delta = now.timeIntervalSince(date)
    if delta < 60 { return "just now" }
    let minutes = Int(round(delta / 60))
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h ago" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d ago"
}
