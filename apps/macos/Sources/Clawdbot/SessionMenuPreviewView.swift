import ClawdbotChatUI
import ClawdbotKit
import OSLog
import SwiftUI

struct SessionPreviewItem: Identifiable, Sendable {
    let id: String
    let role: PreviewRole
    let text: String
}

enum PreviewRole: String, Sendable {
    case user
    case assistant
    case tool
    case system
    case other

    var label: String {
        switch self {
        case .user: "User"
        case .assistant: "Agent"
        case .tool: "Tool"
        case .system: "System"
        case .other: "Other"
        }
    }
}

actor SessionPreviewCache {
    static let shared = SessionPreviewCache()

    private struct CacheEntry {
        let items: [SessionPreviewItem]
        let updatedAt: Date
    }

    private var entries: [String: CacheEntry] = [:]

    func cachedItems(for sessionKey: String, maxAge: TimeInterval) -> [SessionPreviewItem]? {
        guard let entry = self.entries[sessionKey] else { return nil }
        guard Date().timeIntervalSince(entry.updatedAt) < maxAge else { return nil }
        return entry.items
    }

    func store(items: [SessionPreviewItem], for sessionKey: String) {
        self.entries[sessionKey] = CacheEntry(items: items, updatedAt: Date())
    }

    func lastItems(for sessionKey: String) -> [SessionPreviewItem]? {
        self.entries[sessionKey]?.items
    }
}

#if DEBUG
extension SessionPreviewCache {
    func _testSet(items: [SessionPreviewItem], for sessionKey: String, updatedAt: Date = Date()) {
        self.entries[sessionKey] = CacheEntry(items: items, updatedAt: updatedAt)
    }

    func _testReset() {
        self.entries = [:]
    }
}
#endif

struct SessionMenuPreviewSnapshot: Sendable {
    let items: [SessionPreviewItem]
    let status: SessionMenuPreviewView.LoadStatus
}

struct SessionMenuPreviewView: View {
    let width: CGFloat
    let maxLines: Int
    let title: String
    let items: [SessionPreviewItem]
    let status: LoadStatus

    @Environment(\.menuItemHighlighted) private var isHighlighted

    enum LoadStatus: Equatable {
        case loading
        case ready
        case empty
        case error(String)
    }

    private var primaryColor: Color {
        if self.isHighlighted {
            return Color(nsColor: .selectedMenuItemTextColor)
        }
        return Color(nsColor: .labelColor)
    }

    private var secondaryColor: Color {
        if self.isHighlighted {
            return Color(nsColor: .selectedMenuItemTextColor).opacity(0.85)
        }
        return Color(nsColor: .secondaryLabelColor)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(self.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.secondaryColor)
                Spacer(minLength: 8)
            }

            switch self.status {
            case .loading:
                self.placeholder("Loading preview…")
            case .empty:
                self.placeholder("No recent messages")
            case let .error(message):
                self.placeholder(message)
            case .ready:
                if self.items.isEmpty {
                    self.placeholder("No recent messages")
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(self.items) { item in
                            self.previewRow(item)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, 16)
        .padding(.trailing, 11)
        .frame(width: max(1, self.width), alignment: .leading)
    }

    @ViewBuilder
    private func previewRow(_ item: SessionPreviewItem) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Text(item.role.label)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(self.roleColor(item.role))
                .frame(width: 50, alignment: .leading)

            Text(item.text)
                .font(.caption)
                .foregroundStyle(self.primaryColor)
                .multilineTextAlignment(.leading)
                .lineLimit(self.maxLines)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func roleColor(_ role: PreviewRole) -> Color {
        if self.isHighlighted { return Color(nsColor: .selectedMenuItemTextColor).opacity(0.9) }
        switch role {
        case .user: return .accentColor
        case .assistant: return .secondary
        case .tool: return .orange
        case .system: return .gray
        case .other: return .secondary
        }
    }

    @ViewBuilder
    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(self.primaryColor)
    }
}

enum SessionMenuPreviewLoader {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "SessionPreview")
    private static let previewTimeoutSeconds: Double = 4
    private static let cacheMaxAgeSeconds: TimeInterval = 30

    private struct PreviewTimeoutError: LocalizedError {
        var errorDescription: String? { "preview timeout" }
    }

    static func load(sessionKey: String, maxItems: Int) async -> SessionMenuPreviewSnapshot {
        if let cached = await SessionPreviewCache.shared.cachedItems(for: sessionKey, maxAge: cacheMaxAgeSeconds) {
            return self.snapshot(from: cached)
        }

        do {
            let timeoutMs = Int(self.previewTimeoutSeconds * 1000)
            let payload = try await AsyncTimeout.withTimeout(
                seconds: self.previewTimeoutSeconds,
                onTimeout: { PreviewTimeoutError() },
                operation: {
                    try await GatewayConnection.shared.chatHistory(
                        sessionKey: sessionKey,
                        limit: self.previewLimit(for: maxItems),
                        timeoutMs: timeoutMs)
                })
            let built = Self.previewItems(from: payload, maxItems: maxItems)
            await SessionPreviewCache.shared.store(items: built, for: sessionKey)
            return Self.snapshot(from: built)
        } catch is CancellationError {
            return SessionMenuPreviewSnapshot(items: [], status: .loading)
        } catch {
            let fallback = await SessionPreviewCache.shared.lastItems(for: sessionKey)
            if let fallback {
                return Self.snapshot(from: fallback)
            }
            let errorDescription = String(describing: error)
            Self.logger.warning(
                "Session preview failed session=\(sessionKey, privacy: .public) " +
                    "error=\(errorDescription, privacy: .public)")
            return SessionMenuPreviewSnapshot(items: [], status: .error("Preview unavailable"))
        }
    }

    private static func snapshot(from items: [SessionPreviewItem]) -> SessionMenuPreviewSnapshot {
        SessionMenuPreviewSnapshot(items: items, status: items.isEmpty ? .empty : .ready)
    }

    private static func previewLimit(for maxItems: Int) -> Int {
        min(max(maxItems * 3, 20), 120)
    }

    private static func previewItems(
        from payload: ClawdbotChatHistoryPayload,
        maxItems: Int) -> [SessionPreviewItem]
    {
        let raw: [ClawdbotKit.AnyCodable] = payload.messages ?? []
        let messages = self.decodeMessages(raw)
        let built = messages.compactMap { message -> SessionPreviewItem? in
            guard let text = self.previewText(for: message) else { return nil }
            let isTool = self.isToolCall(message)
            let role = self.previewRole(message.role, isTool: isTool)
            let id = "\(message.timestamp ?? 0)-\(UUID().uuidString)"
            return SessionPreviewItem(id: id, role: role, text: text)
        }

        let trimmed = built.suffix(maxItems)
        return Array(trimmed.reversed())
    }

    private static func decodeMessages(_ raw: [ClawdbotKit.AnyCodable]) -> [ClawdbotChatMessage] {
        raw.compactMap { item in
            guard let data = try? JSONEncoder().encode(item) else { return nil }
            return try? JSONDecoder().decode(ClawdbotChatMessage.self, from: data)
        }
    }

    private static func previewRole(_ raw: String, isTool: Bool) -> PreviewRole {
        if isTool { return .tool }
        switch raw.lowercased() {
        case "user": return .user
        case "assistant": return .assistant
        case "system": return .system
        case "tool": return .tool
        default: return .other
        }
    }

    private static func previewText(for message: ClawdbotChatMessage) -> String? {
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }

        let toolNames = self.toolNames(for: message)
        if !toolNames.isEmpty {
            let shown = toolNames.prefix(2)
            let overflow = toolNames.count - shown.count
            var label = "call \(shown.joined(separator: ", "))"
            if overflow > 0 { label += " +\(overflow)" }
            return label
        }

        if let media = self.mediaSummary(for: message) {
            return media
        }

        return nil
    }

    private static func isToolCall(_ message: ClawdbotChatMessage) -> Bool {
        if message.toolName?.nonEmpty != nil { return true }
        return message.content.contains { $0.name?.nonEmpty != nil || $0.type?.lowercased() == "toolcall" }
    }

    private static func toolNames(for message: ClawdbotChatMessage) -> [String] {
        var names: [String] = []
        for content in message.content {
            if let name = content.name?.nonEmpty {
                names.append(name)
            }
        }
        if let toolName = message.toolName?.nonEmpty {
            names.append(toolName)
        }
        return Self.dedupePreservingOrder(names)
    }

    private static func mediaSummary(for message: ClawdbotChatMessage) -> String? {
        let types = message.content.compactMap { content -> String? in
            let raw = content.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard let raw, !raw.isEmpty else { return nil }
            if raw == "text" || raw == "toolcall" { return nil }
            return raw
        }
        guard let first = types.first else { return nil }
        return "[\(first)]"
    }

    private static func dedupePreservingOrder(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for value in values where !seen.contains(value) {
            seen.insert(value)
            result.append(value)
        }
        return result
    }
}
