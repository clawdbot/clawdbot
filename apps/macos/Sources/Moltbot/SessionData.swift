import Foundation
import SwiftUI

struct GatewaySessionDefaultsRecord: Codable {
    let model: String?
    let contextTokens: Int?
}

struct GatewaySessionEntryRecord: Codable {
    let key: String
    let displayName: String?
    let provider: String?
    let subject: String?
    let room: String?
    let space: String?
    let updatedAt: Double?
    let sessionId: String?
    let systemSent: Bool?
    let abortedLastRun: Bool?
    let thinkingLevel: String?
    let verboseLevel: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let model: String?
    let contextTokens: Int?
}

struct GatewaySessionsListResponse: Codable {
    let ts: Double?
    let path: String
    let count: Int
    let defaults: GatewaySessionDefaultsRecord?
    let sessions: [GatewaySessionEntryRecord]
}

struct SessionTokenStats {
    let input: Int
    let output: Int
    let total: Int
    let contextTokens: Int

    var contextSummaryShort: String {
        "\(Self.formatKTokens(self.total))/\(Self.formatKTokens(self.contextTokens))"
    }

    var percentUsed: Int? {
        guard self.contextTokens > 0, self.total > 0 else { return nil }
        return min(100, Int(round((Double(self.total) / Double(self.contextTokens)) * 100)))
    }

    var summary: String {
        let parts = ["in \(input)", "out \(output)", "total \(total)"]
        var text = parts.joined(separator: " | ")
        if let percentUsed {
            text += " (\(percentUsed)% of \(self.contextTokens))"
        }
        return text
    }

    static func formatKTokens(_ value: Int) -> String {
        if value < 1000 { return "\(value)" }
        let thousands = Double(value) / 1000
        let decimals = value >= 10000 ? 0 : 1
        return String(format: "%.\(decimals)fk", thousands)
    }
}

struct SessionRow: Identifiable {
    let id: String
    let key: String
    let kind: SessionKind
    let displayName: String?
    let provider: String?
    let subject: String?
    let room: String?
    let space: String?
    let updatedAt: Date?
    let sessionId: String?
    let thinkingLevel: String?
    let verboseLevel: String?
    let systemSent: Bool
    let abortedLastRun: Bool
    let tokens: SessionTokenStats
    let model: String?

    var ageText: String { relativeAge(from: self.updatedAt) }
    var label: String { self.displayName ?? self.key }

    var flagLabels: [String] {
        var flags: [String] = []
        if let thinkingLevel { flags.append("think \(thinkingLevel)") }
        if let verboseLevel { flags.append("verbose \(verboseLevel)") }
        if self.systemSent { flags.append("system sent") }
        if self.abortedLastRun { flags.append("aborted") }
        return flags
    }
}

enum SessionKind {
    case direct, group, global, unknown

    static func from(key: String) -> SessionKind {
        if key == "global" { return .global }
        if key.hasPrefix("group:") { return .group }
        if key.contains(":group:") { return .group }
        if key.contains(":channel:") { return .group }
        if key == "unknown" { return .unknown }
        return .direct
    }

    var label: String {
        switch self {
        case .direct: "Direct"
        case .group: "Group"
        case .global: "Global"
        case .unknown: "Unknown"
        }
    }

    var tint: Color {
        switch self {
        case .direct: .accentColor
        case .group: .orange
        case .global: .purple
        case .unknown: .gray
        }
    }
}

struct SessionDefaults {
    let model: String
    let contextTokens: Int
}

extension SessionRow {
    static var previewRows: [SessionRow] {
        [
            SessionRow(
                id: "direct-1",
                key: "user@example.com",
                kind: .direct,
                displayName: nil,
                provider: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: Date().addingTimeInterval(-90),
                sessionId: "sess-direct-1234",
                thinkingLevel: "low",
                verboseLevel: "info",
                systemSent: false,
                abortedLastRun: false,
                tokens: SessionTokenStats(input: 320, output: 680, total: 1000, contextTokens: 200_000),
                model: "claude-3.5-sonnet"),
            SessionRow(
                id: "group-1",
                key: "discord:channel:release-squad",
                kind: .group,
                displayName: "discord:#release-squad",
                provider: "discord",
                subject: nil,
                room: "#release-squad",
                space: nil,
                updatedAt: Date().addingTimeInterval(-3600),
                sessionId: "sess-group-4321",
                thinkingLevel: "medium",
                verboseLevel: nil,
                systemSent: true,
                abortedLastRun: true,
                tokens: SessionTokenStats(input: 5000, output: 1200, total: 6200, contextTokens: 200_000),
                model: "claude-opus-4-5"),
            SessionRow(
                id: "global",
                key: "global",
                kind: .global,
                displayName: nil,
                provider: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: Date().addingTimeInterval(-86400),
                sessionId: nil,
                thinkingLevel: nil,
                verboseLevel: nil,
                systemSent: false,
                abortedLastRun: false,
                tokens: SessionTokenStats(input: 150, output: 220, total: 370, contextTokens: 200_000),
                model: "gpt-4.1-mini"),
        ]
    }
}

struct ModelChoice: Identifiable, Hashable, Codable {
    let id: String
    let name: String
    let provider: String
    let contextWindow: Int?
}

extension String? {
    var isNilOrEmpty: Bool {
        switch self {
        case .none: true
        case let .some(value): value.isEmpty
        }
    }
}

extension [String] {
    fileprivate func dedupedPreserveOrder() -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for item in self where !seen.contains(item) {
            seen.insert(item)
            result.append(item)
        }
        return result
    }
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
    static let fallbackModel = "claude-opus-4-5"
    static let fallbackContextTokens = 200_000

    static let defaultStorePath = standardize(
        FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdbot/sessions/sessions.json").path)

    static func loadSnapshot(
        activeMinutes: Int? = nil,
        limit: Int? = nil,
        includeGlobal: Bool = true,
        includeUnknown: Bool = true) async throws -> SessionStoreSnapshot
    {
        var params: [String: AnyHashable] = [
            "includeGlobal": AnyHashable(includeGlobal),
            "includeUnknown": AnyHashable(includeUnknown),
        ]
        if let activeMinutes { params["activeMinutes"] = AnyHashable(activeMinutes) }
        if let limit { params["limit"] = AnyHashable(limit) }

        let data: Data
        do {
            data = try await ControlChannel.shared.request(method: "sessions.list", params: params)
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if msg.localizedCaseInsensitiveContains("unknown method: sessions.list") {
                throw SessionLoadError.gatewayUnavailable(
                    "Gateway is too old (missing sessions.list). Restart/update the gateway.")
            }
            throw SessionLoadError.gatewayUnavailable(msg)
        }

        let decoded: GatewaySessionsListResponse
        do {
            decoded = try JSONDecoder().decode(GatewaySessionsListResponse.self, from: data)
        } catch {
            throw SessionLoadError.decodeFailed(error.localizedDescription)
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
            let model = entry.model ?? defaults.model

            return SessionRow(
                id: entry.key,
                key: entry.key,
                kind: SessionKind.from(key: entry.key),
                displayName: entry.displayName,
                provider: entry.provider,
                subject: entry.subject,
                room: entry.room,
                space: entry.space,
                updatedAt: updated,
                sessionId: entry.sessionId,
                thinkingLevel: entry.thinkingLevel,
                verboseLevel: entry.verboseLevel,
                systemSent: entry.systemSent ?? false,
                abortedLastRun: entry.abortedLastRun ?? false,
                tokens: SessionTokenStats(
                    input: input,
                    output: output,
                    total: total,
                    contextTokens: context),
                model: model)
        }.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }

        return SessionStoreSnapshot(storePath: decoded.path, defaults: defaults, rows: rows)
    }

    static func loadRows() async throws -> [SessionRow] {
        try await self.loadSnapshot().rows
    }

    private static func standardize(_ path: String) -> String {
        (path as NSString).expandingTildeInPath.replacingOccurrences(of: "//", with: "/")
    }
}

func relativeAge(from date: Date?) -> String {
    guard let date else { return "unknown" }
    let delta = Date().timeIntervalSince(date)
    if delta < 60 { return "just now" }
    let minutes = Int(round(delta / 60))
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h ago" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d ago"
}
