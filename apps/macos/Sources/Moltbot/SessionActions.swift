import AppKit
import Foundation

enum SessionActions {
    static func patchSession(
        key: String,
        thinking: String?? = nil,
        verbose: String?? = nil) async throws
    {
        var params: [String: AnyHashable] = ["key": AnyHashable(key)]

        if let thinking {
            params["thinkingLevel"] = thinking.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }
        if let verbose {
            params["verboseLevel"] = verbose.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }

        _ = try await ControlChannel.shared.request(method: "sessions.patch", params: params)
    }

    static func resetSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.reset",
            params: ["key": AnyHashable(key)])
    }

    static func deleteSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.delete",
            params: ["key": AnyHashable(key), "deleteTranscript": AnyHashable(true)])
    }

    static func compactSession(key: String, maxLines: Int = 400) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.compact",
            params: ["key": AnyHashable(key), "maxLines": AnyHashable(maxLines)])
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
            let home = FileManager().homeDirectoryForCurrentUser
            urls.append(home.appendingPathComponent(".clawdbot/sessions/\(sessionId).jsonl"))
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
