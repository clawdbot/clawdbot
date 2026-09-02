import AppKit
import Foundation
import OpenClawKit

/// Operator-owned recovery for a no-row, different-key native identity conflict.
@MainActor
enum DeviceIdentityConflictRecovery {
    static func candidateMenuTitle(_ candidate: DeviceIdentityConflictCandidate) -> String {
        "\(candidate.sourcePath) [\(candidate.fingerprint)]"
    }

    static func confirmRePairMessage() -> String {
        "Creating a new identity archives the preserved sources and requires re-approving this Mac on the Gateway."
    }

    /// Presents the conflict and applies an explicit operator choice. Returns true after a
    /// successful import or re-pair so callers can retry the connect that was blocked.
    @discardableResult
    static func presentIfNeeded(conflict: DeviceIdentityConflictError) -> Bool
    {
        guard !conflict.candidates.isEmpty else { return false }
        NSApp.activate(ignoringOtherApps: true)
        while true {
            let popup = Self.makeCandidatePopup(conflict.candidates)
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Conflicting device identities"
            alert.informativeText = "This Mac preserved more than one device identity with different keys. "
                + "Choose the identity this Mac should keep, or create a new one."
            alert.accessoryView = popup
            alert.addButton(withTitle: "Use Selected Identity")
            alert.addButton(withTitle: "Create New Identity")
            alert.addButton(withTitle: "Cancel")
            if #available(macOS 11.0, *) {
                alert.buttons[1].hasDestructiveAction = true
            }

            switch alert.runModal() {
            case .alertFirstButtonReturn:
                guard let fingerprint = popup.selectedItem?.representedObject as? String else {
                    return false
                }
                return self.apply(
                    .select(fingerprint: fingerprint),
                    profile: conflict.profile)
            case .alertSecondButtonReturn:
                guard Self.confirmRePair() else { continue }
                return self.apply(.rePair, profile: conflict.profile)
            default:
                return false
            }
        }
    }

    static func presentFromMenu() {
        guard let conflict = DeviceIdentityConflictError.lastRecorded() else { return }
        guard self.presentIfNeeded(conflict: conflict) else { return }
        MacNodeModeCoordinator.shared.retryAfterIdentityRecovery()
        Task { await NodesStore.shared.prepareLocalNodeIdentity() }
    }

    private static func apply(
        _ choice: DeviceIdentityReconciliationChoice,
        profile: GatewayDeviceIdentityProfile) -> Bool
    {
        do {
            _ = try DeviceIdentityStore.reconcileConflictingLegacyIdentities(
                profile: profile,
                choice: choice)
            return true
        } catch {
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "Could not reconcile device identities"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return false
        }
    }

    private static func confirmRePair() -> Bool {
        let confirm = NSAlert()
        confirm.alertStyle = .critical
        confirm.messageText = "Create a new Mac identity?"
        confirm.informativeText = self.confirmRePairMessage()
        confirm.addButton(withTitle: "Create New Identity")
        confirm.addButton(withTitle: "Cancel")
        if #available(macOS 11.0, *) {
            confirm.buttons[0].hasDestructiveAction = true
        }
        return confirm.runModal() == .alertFirstButtonReturn
    }

    private static func makeCandidatePopup(_ candidates: [DeviceIdentityConflictCandidate]) -> NSPopUpButton {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 420, height: 24), pullsDown: false)
        for candidate in candidates {
            popup.addItem(withTitle: self.candidateMenuTitle(candidate))
            popup.lastItem?.representedObject = candidate.fingerprint
        }
        popup.selectItem(at: 0)
        return popup
    }
}
