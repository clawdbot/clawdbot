import AppKit
import Foundation
import OpenClawChatUI
import OpenClawKit

enum SessionActions {
    static func patchSession(
        key: String,
        thinking: String?? = nil,
        verbose: String?? = nil) async throws
    {
        let request = OpenClawChatGatewayRequests.patchSessionPreferences(
            sessionKey: key,
            agentID: nil,
            thinkingLevel: thinking,
            verboseLevel: verbose)
        _ = try await ControlChannel.shared.request(request)
    }

    static func resetSession(key: String) async throws {
        let request = OpenClawChatGatewayRequests.resetSession(sessionKey: key, agentID: nil)
        _ = try await ControlChannel.shared.request(request)
    }

    static func deleteSession(key: String) async throws {
        let request = OpenClawChatGatewayRequests.deleteSession(sessionKey: key, agentID: nil)
        _ = try await ControlChannel.shared.request(request)
    }

    static func compactSession(key: String, maxLines: Int = 400) async throws {
        let request = OpenClawChatGatewayRequests.compactSession(
            sessionKey: key,
            agentID: nil,
            maxLines: maxLines)
        let response = try await ControlChannel.shared.request(request, retryTransportFailures: false)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    @MainActor
    static func confirmDestructiveAction(title: String, message: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    @MainActor
    static func presentError(title: String, error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .warning
        alert.runModal()
    }

    @MainActor
    static func openSessionLogInCode(sessionId: String, storePath: String?) {
        let candidates: [URL] = {
            var urls: [URL] = []
            if let storePath, !storePath.isEmpty {
                let dir = URL(fileURLWithPath: storePath).deletingLastPathComponent()
                urls.append(dir.appendingPathComponent("\(sessionId).jsonl"))
            }
            urls.append(OpenClawPaths.stateDirURL.appendingPathComponent("sessions/\(sessionId).jsonl"))
            return urls
        }()

        let existing = candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
        guard let url = existing else {
            let alert = NSAlert()
            alert.messageText = "Session log not found"
            alert.informativeText = sessionId
            alert.runModal()
            return
        }

        let proc = Process()
        proc.launchPath = "/usr/bin/env"
        proc.arguments = ["code", url.path]
        if (try? proc.run()) != nil {
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
