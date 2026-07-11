import AppKit
import Foundation
import OpenClawKit

struct BrowserSystemProfile: Codable, Equatable, Identifiable {
    let browser: String
    let id: String
    let name: String
    let hasCookies: Bool

    var displayName: String {
        let browserName = self.browser.prefix(1).uppercased() + self.browser.dropFirst()
        return "\(browserName) — \(self.name)"
    }
}

enum BrowserProfileImportDisposition: String, Codable, Equatable {
    case dismissed
    case imported
}

struct BrowserProfileImportOutcome: Codable, Equatable {
    let status: BrowserProfileImportDisposition
}

struct BrowserProfileImportStatus: Codable, Equatable {
    let enabled: Bool
    let systemProfiles: [BrowserSystemProfile]
    let state: BrowserProfileImportOutcome?
    let suggestedTarget: String

    var importableProfiles: [BrowserSystemProfile] {
        self.systemProfiles.filter(\.hasCookies)
    }
}

private struct BrowserProfileImportResult: Decodable {
    struct Counts: Decodable {
        let total: Int
        let imported: Int
    }

    let into: String
    let cookies: Counts
}

@MainActor
final class BrowserProfileImportPrompter {
    static let shared = BrowserProfileImportPrompter()

    private var isPrompting = false
    private var handledThisSession = false

    static func shouldOfferPrompt(status: BrowserProfileImportStatus, force: Bool) -> Bool {
        status.enabled && !status.importableProfiles.isEmpty && (force || status.state == nil)
    }

    func checkAndPromptIfNeeded(force: Bool = false) {
        guard !self.isPrompting else { return }
        guard force || !self.handledThisSession else { return }
        guard AppStateStore.shared.onboardingSeen else { return }
        guard AppStateStore.shared.connectionMode == .local else {
            if force {
                Self.showMessage(
                    title: "Browser import requires Local mode",
                    message: "Switch this Mac app to a local Gateway before importing browser cookies.")
            }
            return
        }

        self.isPrompting = true
        Task { @MainActor in
            defer { self.isPrompting = false }
            do {
                let status: BrowserProfileImportStatus = try await Self.browserRequest(
                    method: "GET",
                    path: "/system-profile-import/status")
                if !force {
                    self.handledThisSession = true
                }
                guard Self.shouldOfferPrompt(status: status, force: force) else {
                    if force {
                        let message = status.enabled
                            ? "No Chrome, Brave, Edge, or Chromium profile with cookies was found on this Mac."
                            : "System browser profile import is disabled in the local Gateway configuration."
                        Self.showMessage(title: "No browser login available", message: message)
                    }
                    return
                }
                await self.presentImportPrompt(status: status)
            } catch {
                if force {
                    Self.showMessage(title: "Browser import unavailable", message: error.localizedDescription)
                }
            }
        }
    }

    private func presentImportPrompt(status: BrowserProfileImportStatus) async {
        let profiles = status.importableProfiles
        let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 28), pullsDown: false)
        for profile in profiles {
            picker.addItem(withTitle: profile.displayName)
        }

        let targetProfile = status.suggestedTarget
        let importScope = [
            "OpenClaw can copy cookies into an isolated managed profile and make it the default for agent browsing.",
            "\(targetProfile) will not include local storage or IndexedDB.",
            "Touch ID may be required.",
        ].joined(separator: " ")
        let alert = NSAlert()
        alert.messageText = "Use your browser login in OpenClaw?"
        alert.informativeText = importScope
        alert.accessoryView = picker
        alert.addButton(withTitle: "Import Cookies")
        alert.addButton(withTitle: "Not Now")

        guard alert.runModal() == .alertFirstButtonReturn else {
            let _: [String: Bool]? = try? await Self.browserRequest(
                method: "POST",
                path: "/system-profile-import/dismiss")
            return
        }

        let selectedIndex = max(0, picker.indexOfSelectedItem)
        guard profiles.indices.contains(selectedIndex) else { return }
        let profile = profiles[selectedIndex]
        do {
            let body: [String: AnyCodable] = [
                "browser": AnyCodable(profile.browser),
                "systemProfile": AnyCodable(profile.id),
                "into": AnyCodable(status.suggestedTarget),
                "makeDefault": AnyCodable(true),
            ]
            let result: BrowserProfileImportResult = try await Self.browserRequest(
                method: "POST",
                path: "/profiles/import",
                body: body,
                timeoutMs: 120_000)
            let importedSummary =
                "Imported \(result.cookies.imported) of \(result.cookies.total) cookies into \(result.into). " +
                "This profile is now the default for agent browsing."
            Self.showMessage(
                title: "Browser login imported",
                message: importedSummary)
        } catch {
            Self.showMessage(title: "Browser import failed", message: error.localizedDescription)
        }
    }

    private static func browserRequest<T: Decodable>(
        method: String,
        path: String,
        body: [String: AnyCodable]? = nil,
        timeoutMs: Double? = nil) async throws -> T
    {
        var params: [String: AnyCodable] = [
            "method": AnyCodable(method),
            "path": AnyCodable(path),
        ]
        if let body {
            params["body"] = AnyCodable(body)
        }
        let data = try await GatewayConnection.shared.request(
            method: "browser.request",
            params: params,
            timeoutMs: timeoutMs)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func showMessage(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
