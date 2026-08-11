import Foundation

struct QuickChatRecentMenuItem: Equatable, Identifiable {
    let id: String
    let title: String
    let target: QuickChatSessionTargetOverride?
    let isSelected: Bool
}

enum QuickChatRecentMenuLogic {
    static func items(
        rows: [SessionRow],
        agentName: String,
        selectedTarget: QuickChatSessionTargetOverride?,
        now: Date = Date()) -> [QuickChatRecentMenuItem]
    {
        let newMessage = QuickChatRecentMenuItem(
            id: "new-message",
            // String(localized:) keeps the NSMenuItem title translatable; the relative
            // age below uses the shared app-wide relativeAge helper, unlocalized here as
            // everywhere else it is used (a separate app-wide follow-up).
            title: String(localized: "New message to \(agentName)"),
            target: nil,
            isSelected: selectedTarget == nil)
        let recents = rows.prefix(5).map { row in
            let target = QuickChatSessionTargetOverride(key: row.key, displayName: row.label)
            return QuickChatRecentMenuItem(
                id: row.key,
                title: "\(row.label) — \(relativeAge(from: row.updatedAt, now: now))",
                target: target,
                isSelected: selectedTarget?.key == row.key)
        }
        return [newMessage] + recents
    }
}
