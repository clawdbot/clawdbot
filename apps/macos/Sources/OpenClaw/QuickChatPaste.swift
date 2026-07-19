import Carbon.HIToolbox
import CoreGraphics
import Foundation
import OpenClawChatUI

enum QuickChatPasteLogic {
    static func finalAssistantText(
        messages: [OpenClawChatMessage],
        afterUserIdempotencyKey: String?,
        streamingAssistantText: String?,
        pendingRunCount: Int) -> String?
    {
        guard streamingAssistantText == nil,
              pendingRunCount == 0,
              let afterUserIdempotencyKey,
              let userIndex = messages.lastIndex(where: {
                  $0.role.lowercased() == "user" && $0.idempotencyKey == afterUserIdempotencyKey
              }),
              !messages[(userIndex + 1)...].contains(where: { $0.role.lowercased() == "user" }),
              let assistantIndex = messages.indices.reversed().first(where: {
                  $0 > userIndex && messages[$0].role.lowercased() == "assistant"
              })
        else { return nil }

        let lastConversationalIndex = messages.indices.reversed().first(where: {
            let role = messages[$0].role.lowercased()
            return role == "user" || role == "assistant"
        })
        guard lastConversationalIndex == assistantIndex else { return nil }
        let text = ChatMessageVisibleText.visibleText(in: messages[assistantIndex])
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }

    static func canPaste(
        frontmostProcessIdentifier: Int32?,
        ownProcessIdentifier: Int32) -> Bool
    {
        guard let frontmostProcessIdentifier else { return false }
        return frontmostProcessIdentifier != ownProcessIdentifier
    }

    static func isExpectedTarget(
        frontmostProcessIdentifier: Int32?,
        targetProcessIdentifier: Int32) -> Bool
    {
        frontmostProcessIdentifier == targetProcessIdentifier
    }
}

enum QuickChatPasteEventInjector {
    static func postCommandV(to processIdentifier: pid_t) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(
                  keyboardEventSource: source,
                  virtualKey: CGKeyCode(kVK_ANSI_V),
                  keyDown: true),
              let keyUp = CGEvent(
                  keyboardEventSource: source,
                  virtualKey: CGKeyCode(kVK_ANSI_V),
                  keyDown: false)
        else { return false }
        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.postToPid(processIdentifier)
        keyUp.postToPid(processIdentifier)
        return true
    }
}
