import Foundation
import OpenClawKit
import UIKit

enum IOSDeviceSettingsConsent: Equatable {
    case voiceWake
    case camera
    case healthSummary
    case locationAlways
    case notificationEnrollment

    static func required(
        for key: DeviceSettingKey,
        value: DeviceSettingValue,
        locationMode: OpenClawLocationMode) -> Self?
    {
        switch (key, value) {
        case (.wakeEnabled, .boolean(true)): .voiceWake
        case (.cameraEnabled, .boolean(true)): .camera
        case (.healthSummaryEnabled, .boolean(true)): .healthSummary
        case (.locationMode, .string("always")) where locationMode != .always: .locationAlways
        default: nil
        }
    }

    var title: String {
        switch self {
        case .voiceWake: String(localized: "Enable continuous microphone listening?")
        case .camera: String(localized: "Allow the Gateway to use this device's camera?")
        case .healthSummary: String(localized: "Share Apple Health summaries with the Gateway?")
        case .locationAlways: String(localized: "Allow location access at any time?")
        case .notificationEnrollment: String(localized: "Enable OpenClaw Hosted Push Relay?")
        }
    }

    var detail: String {
        switch self {
        case .voiceWake:
            String(localized: "Voice Wake will continuously listen for wake phrases through this device's microphone.")
        case .camera:
            String(
                localized: """
                The Gateway can request photos and video from this device's camera, subject to iOS permission.
                """)
        case .healthSummary:
            String(localized: """
            OpenClaw reads steps, sleep, resting heart rate, and workouts from Apple Health only when a summary is \
            requested. Only the aggregate leaves this device through your Gateway to your configured AI provider; \
            raw samples stay on this device and results may remain in chat history.
            """)
        case .locationAlways:
            String(localized: "The Gateway can request this device's location even when OpenClaw is not in use.")
        case .notificationEnrollment:
            String(localized: "Enabling this sends delivery data through OpenClaw's hosted push relay.")
        }
    }
}

@MainActor
final class IOSDeviceSettingsConsentPresenter {
    private var alert: UIAlertController?
    private var continuation: CheckedContinuation<Bool, Never>?

    func confirm(_ consent: IOSDeviceSettingsConsent, from webView: UIView?) async -> Bool {
        guard !Task.isCancelled, self.alert == nil,
              var presenter = webView?.window?.rootViewController
        else { return false }
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        guard !presenter.isBeingDismissed else { return false }
        // UIAlertController owns system typography and keyboard-default behavior for native consent.
        let alert = UIAlertController(title: consent.title, message: consent.detail, preferredStyle: .alert)
        let cancel = UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { [weak self, weak alert] _ in
            guard let self, self.alert === alert else { return }
            self.complete(false)
        }
        alert.addAction(cancel)
        alert.addAction(UIAlertAction(title: String(localized: "Allow"), style: .default) { [weak self, weak alert] _ in
            guard let self, self.alert === alert else { return }
            self.complete(true)
        })
        alert.preferredAction = cancel
        self.alert = alert
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            presenter.present(alert, animated: true)
        }
    }

    func cancel() {
        self.alert?.dismiss(animated: false)
        self.complete(false)
    }

    private func complete(_ allowed: Bool) {
        let continuation = self.continuation
        self.continuation = nil
        self.alert = nil
        continuation?.resume(returning: allowed)
    }
}
