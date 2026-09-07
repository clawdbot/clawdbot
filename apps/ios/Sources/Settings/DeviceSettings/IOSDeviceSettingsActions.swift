import Foundation
import OpenClawKit
import UIKit
import UserNotifications

@MainActor
enum IOSDeviceSettingsActions {
    static func applyLocationMode(
        _ mode: OpenClawLocationMode,
        appModel: NodeAppModel,
        isCurrent: @MainActor () -> Bool = { true }) async -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        let granted = await appModel.requestLocationPermissions(mode: mode, isCurrent: isCurrent)
        guard granted, !Task.isCancelled, isCurrent() else { return false }
        UserDefaults.standard.set(mode.rawValue, forKey: "location.enabledMode")
        return true
    }

    static func setNotificationsEnabled(
        _ enabled: Bool,
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async -> UNAuthorizationStatus?
    {
        guard !Task.isCancelled, isCurrent() else { return nil }
        if !enabled {
            UserDefaults.standard.set(false, forKey: NotificationServingPreference.storageKey)
            UIApplication.shared.unregisterForRemoteNotifications()
            return nil
        }
        guard await self.prepareNotificationEnrollment(
            confirmDisclosure: confirmDisclosure,
            isCurrent: isCurrent)
        else { return nil }
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        guard !Task.isCancelled, isCurrent() else { return nil }
        if status == .notDetermined {
            return await self.authorizeNotifications(isCurrent: isCurrent)
        }
        UserDefaults.standard.set(true, forKey: NotificationServingPreference.storageKey)
        self.registerForRemoteNotificationsIfEnrollmentReady(status: status)
        if !SettingsNotificationStatus(status).allowsNotifications,
           let url = URL(string: UIApplication.openNotificationSettingsURLString)
        {
            await UIApplication.shared.open(url)
        }
        return status
    }

    static func requestNotificationPermission(
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async -> UNAuthorizationStatus?
    {
        guard await self.prepareNotificationEnrollment(
            confirmDisclosure: confirmDisclosure,
            isCurrent: isCurrent)
        else { return nil }
        return await self.authorizeNotifications(isCurrent: isCurrent)
    }

    static func registerForRemoteNotificationsIfEnrollmentReady(status: UNAuthorizationStatus) {
        guard NotificationServingPreference.isEnabled(),
              !PushBuildConfig.current.usesOpenClawHostedRelay || PushEnrollmentConsent.disclosureAccepted,
              SettingsNotificationStatus(status).allowsNotifications
        else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private static func prepareNotificationEnrollment(
        confirmDisclosure: @MainActor () async -> Bool,
        isCurrent: @MainActor () -> Bool) async -> Bool
    {
        guard !Task.isCancelled, isCurrent() else { return false }
        if PushBuildConfig.current.usesOpenClawHostedRelay, !PushEnrollmentConsent.disclosureAccepted {
            guard await confirmDisclosure(), !Task.isCancelled, isCurrent() else { return false }
            PushEnrollmentConsent.markDisclosureAccepted()
        }
        return true
    }

    private static func authorizeNotifications(
        isCurrent: @escaping @MainActor @Sendable () -> Bool) async -> UNAuthorizationStatus?
    {
        guard !Task.isCancelled, isCurrent() else { return nil }
        let center = UNUserNotificationCenter.current()
        let granted = await PermissionRequestBridge.awaitRequest(isCurrent: isCurrent) { completion in
            center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in completion(granted) }
        }
        guard !Task.isCancelled, isCurrent() else { return nil }
        let status = await center.notificationSettings().authorizationStatus
        guard !Task.isCancelled, isCurrent() else { return nil }
        UserDefaults.standard.set(
            granted && SettingsNotificationStatus(status).allowsNotifications,
            forKey: NotificationServingPreference.storageKey)
        self.registerForRemoteNotificationsIfEnrollmentReady(status: status)
        return status
    }
}
