import SwiftUI

enum StatusActivityBuilder {
    @MainActor
    static func build(
        appModel: NodeAppModel,
        voiceWakeEnabled: Bool,
        cameraHUDText: String?,
        cameraHUDKind: NodeAppModel.CameraHUDKind?) -> StatusPill.Activity?
    {
        // Keep the top pill consistent across tabs (camera + voice wake + pairing states).
        if appModel.isBackgrounded {
            return StatusPill.Activity(
                title: "Foreground required",
                systemImage: "exclamationmark.triangle.fill",
                tint: .orange)
        }

        if let gatewayProblem = appModel.lastGatewayProblem {
            switch gatewayProblem.kind {
            case .pairingRequired,
                 .pairingRoleUpgradeRequired,
                 .pairingScopeUpgradeRequired,
                 .pairingMetadataUpgradeRequired:
                return StatusPill.Activity(
                    title: "Approval pending",
                    systemImage: "person.crop.circle.badge.clock",
                    tint: .orange)
            case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
                return StatusPill.Activity(
                    title: "Check network",
                    systemImage: "wifi.exclamationmark",
                    tint: .orange)
            default:
                if gatewayProblem.pauseReconnect {
                    return StatusPill.Activity(
                        title: "Action required",
                        systemImage: "exclamationmark.triangle.fill",
                        tint: .orange)
                }
            }
        }

        let gatewayStatus = appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let gatewayLower = gatewayStatus.lowercased()
        if gatewayLower.contains("repair") {
            return StatusPill.Activity(title: "Repairing…", systemImage: "wrench.and.screwdriver", tint: .orange)
        }
        if gatewayLower.contains("approval") || gatewayLower.contains("pairing") {
            return StatusPill.Activity(title: "Approval pending", systemImage: "person.crop.circle.badge.clock")
        }
        // Avoid duplicating the primary gateway status ("Connecting…") in the activity slot.

        if appModel.screenRecordActive {
            return StatusPill.Activity(title: "Recording screen…", systemImage: "record.circle.fill", tint: .red)
        }

        if let cameraHUDText, !cameraHUDText.isEmpty, let cameraHUDKind {
            let systemImage: String
            let tint: Color?
            switch cameraHUDKind {
            case .photo:
                systemImage = "camera.fill"
                tint = nil
            case .recording:
                systemImage = "video.fill"
                tint = .red
            case .success:
                systemImage = "checkmark.circle.fill"
                tint = .green
            case .error:
                systemImage = "exclamationmark.triangle.fill"
                tint = .red
            }
            return StatusPill.Activity(title: cameraHUDText, systemImage: systemImage, tint: tint)
        }

        if voiceWakeEnabled {
            let voiceStatus = appModel.voiceWake.statusText
            if voiceStatus.localizedCaseInsensitiveContains("microphone permission") {
                return StatusPill.Activity(title: "Mic permission", systemImage: "mic.slash", tint: .orange)
            }
            if voiceStatus == "Paused" {
                // Talk mode intentionally pauses voice wake to release the mic. Don't spam the HUD for that case.
                if appModel.talkMode.isEnabled {
                    return nil
                }
                let suffix = appModel.isBackgrounded ? " (background)" : ""
                return StatusPill.Activity(title: "Voice Wake paused\(suffix)", systemImage: "pause.circle.fill")
            }
        }

        return nil
    }
}
