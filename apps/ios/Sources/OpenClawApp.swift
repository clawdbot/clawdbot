import BackgroundTasks
import Foundation
import OpenClawKit
import os
import SwiftUI
import UIKit
@preconcurrency import UserNotifications

private struct PendingWatchPromptAction {
    var promptId: String?
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
}

private typealias PendingExecApprovalPrompt = ExecApprovalNotificationPrompt

@MainActor
enum OpenClawAppModelRegistry {
    static var appModel: NodeAppModel?
}

@MainActor
final class OpenClawAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "Push")
    private let backgroundWakeLogger = Logger(subsystem: "ai.openclaw.ios", category: "BackgroundWake")
    private static let wakeRefreshTaskIdentifier = "ai.openclaw.ios.bgrefresh"
    private var backgroundWakeTask: Task<Bool, Never>?
    private var pendingAPNsDeviceToken: Data?
    private var pendingWatchPromptActions: [PendingWatchPromptAction] = []
    private var pendingExecApprovalPrompts: [PendingExecApprovalPrompt] = []
    private var pendingExecApprovalRequestedPushIDs: [String] = []
    private var pendingExecApprovalResolvedPushIDs: [String] = []

    weak var appModel: NodeAppModel? {
        didSet {
            guard let model = self.resolvedAppModel() else { return }
            if let token = self.pendingAPNsDeviceToken {
                self.pendingAPNsDeviceToken = nil
                Task { @MainActor in
                    model.updateAPNsDeviceToken(token)
                }
            }
            if !self.pendingWatchPromptActions.isEmpty {
                let pending = self.pendingWatchPromptActions
                self.pendingWatchPromptActions.removeAll()
                Task { @MainActor in
                    for action in pending {
                        await model.handleMirroredWatchPromptAction(
                            promptId: action.promptId,
                            actionId: action.actionId,
                            actionLabel: action.actionLabel,
                            sessionKey: action.sessionKey)
                    }
                }
            }
            if !self.pendingExecApprovalPrompts.isEmpty {
                let pending = self.pendingExecApprovalPrompts
                self.pendingExecApprovalPrompts.removeAll()
                Task { @MainActor in
                    for prompt in pending {
                        await model.presentExecApprovalNotificationPrompt(prompt)
                    }
                }
            }
            if !self.pendingExecApprovalRequestedPushIDs.isEmpty {
                let pending = self.pendingExecApprovalRequestedPushIDs
                self.pendingExecApprovalRequestedPushIDs.removeAll()
                Task { @MainActor in
                    for approvalId in pending {
                        _ = await model.handleExecApprovalRequestedRemotePush(approvalId: approvalId)
                    }
                }
            }
            if !self.pendingExecApprovalResolvedPushIDs.isEmpty {
                let pending = self.pendingExecApprovalResolvedPushIDs
                self.pendingExecApprovalResolvedPushIDs.removeAll()
                Task { @MainActor in
                    for approvalId in pending {
                        await model.handleExecApprovalResolvedRemotePush(approvalId: approvalId)
                    }
                }
            }
        }
    }

    private func resolvedAppModel() -> NodeAppModel? {
        self.appModel ?? OpenClawAppModelRegistry.appModel
    }

    #if DEBUG
    func _test_resolvedAppModel() -> NodeAppModel? {
        self.resolvedAppModel()
    }
    #endif

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool
    {
        GatewayDiagnostics.log("app delegate: didFinishLaunching")
        if self.appModel == nil {
            self.appModel = OpenClawAppModelRegistry.appModel
        }
        self.registerBackgroundWakeRefreshTask()
        let notificationCenter = UNUserNotificationCenter.current()
        notificationCenter.delegate = self
        ExecApprovalNotificationBridge.registerCategory(center: notificationCenter)
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if let appModel = self.resolvedAppModel() {
            Task { @MainActor in
                appModel.updateAPNsDeviceToken(deviceToken)
            }
            return
        }

        self.pendingAPNsDeviceToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        self.logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void)
    {
        self.logger.info("APNs remote notification received keys=\(userInfo.keys.count, privacy: .public)")
        Task { @MainActor in
            let notificationCenter = LiveNotificationCenter()
            if await ExecApprovalNotificationBridge.handleResolvedPushIfNeeded(
                userInfo: userInfo,
                notificationCenter: notificationCenter)
            {
                if let approvalId = ExecApprovalNotificationBridge.approvalID(from: userInfo) {
                    if let appModel = self.resolvedAppModel() {
                        await appModel.handleExecApprovalResolvedRemotePush(approvalId: approvalId)
                    } else {
                        self.pendingExecApprovalResolvedPushIDs.append(approvalId)
                    }
                }
                completionHandler(.newData)
                return
            }
            guard let appModel = self.resolvedAppModel() else {
                if ExecApprovalNotificationBridge.payloadKind(userInfo: userInfo)
                    == ExecApprovalNotificationBridge.requestedKind,
                    let approvalId = ExecApprovalNotificationBridge.approvalID(from: userInfo)
                {
                    self.pendingExecApprovalRequestedPushIDs.append(approvalId)
                }
                self.logger.info("APNs wake skipped: appModel unavailable")
                self.scheduleBackgroundWakeRefresh(afterSeconds: 90, reason: "silent_push_no_model")
                completionHandler(.noData)
                return
            }
            let handled = await appModel.handleSilentPushWake(userInfo)
            self.logger.info("APNs wake handled=\(handled, privacy: .public)")
            if !handled {
                self.scheduleBackgroundWakeRefresh(afterSeconds: 90, reason: "silent_push_not_applied")
            }
            completionHandler(handled ? .newData : .noData)
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        GatewayDiagnostics.log("app delegate: scene phase changed=\(String(describing: phase))")
        if phase == .background {
            self.scheduleBackgroundWakeRefresh(afterSeconds: 120, reason: "scene_background")
        }
    }

    private func registerBackgroundWakeRefreshTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.wakeRefreshTaskIdentifier,
            using: nil)
        { [weak self] task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleBackgroundWakeRefresh(task: refreshTask)
        }
    }

    private func scheduleBackgroundWakeRefresh(afterSeconds delay: TimeInterval, reason: String) {
        let request = BGAppRefreshTaskRequest(identifier: Self.wakeRefreshTaskIdentifier)
        request.earliestBeginDate = Date().addingTimeInterval(max(60, delay))
        do {
            try BGTaskScheduler.shared.submit(request)
            let scheduledLogMessage =
                "Scheduled background wake refresh reason=\(reason) "
                    + "delaySeconds=\(max(60, delay))"
            self.backgroundWakeLogger.info(
                "\(scheduledLogMessage, privacy: .public)")
        } catch {
            let failedLogMessage =
                "Failed scheduling background wake refresh reason=\(reason) "
                    + "error=\(error.localizedDescription)"
            self.backgroundWakeLogger.error(
                "\(failedLogMessage, privacy: .public)")
        }
    }

    private func handleBackgroundWakeRefresh(task: BGAppRefreshTask) {
        self.scheduleBackgroundWakeRefresh(afterSeconds: 15 * 60, reason: "reschedule")
        self.backgroundWakeTask?.cancel()

        let wakeTask = Task { @MainActor [weak self] in
            guard let self, let appModel = self.resolvedAppModel() else { return false }
            return await appModel.handleBackgroundRefreshWake(trigger: "bg_app_refresh")
        }
        self.backgroundWakeTask = wakeTask
        task.expirationHandler = {
            wakeTask.cancel()
        }
        Task {
            let applied = await wakeTask.value
            task.setTaskCompleted(success: applied)
            self.backgroundWakeLogger.info(
                "Background wake refresh finished applied=\(applied, privacy: .public)")
        }
    }

    private static func isWatchPromptNotification(_ userInfo: [AnyHashable: Any]) -> Bool {
        (userInfo[WatchPromptNotificationBridge.typeKey] as? String) == WatchPromptNotificationBridge.typeValue
    }

    private static func parseWatchPromptAction(
        from response: UNNotificationResponse) -> PendingWatchPromptAction?
    {
        let userInfo = response.notification.request.content.userInfo
        guard Self.isWatchPromptNotification(userInfo) else { return nil }

        let promptId = userInfo[WatchPromptNotificationBridge.promptIDKey] as? String
        let sessionKey = userInfo[WatchPromptNotificationBridge.sessionKeyKey] as? String

        switch response.actionIdentifier {
        case WatchPromptNotificationBridge.actionPrimaryIdentifier:
            let actionId = (userInfo[WatchPromptNotificationBridge.actionPrimaryIDKey] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !actionId.isEmpty else { return nil }
            let actionLabel = userInfo[WatchPromptNotificationBridge.actionPrimaryLabelKey] as? String
            return PendingWatchPromptAction(
                promptId: promptId,
                actionId: actionId,
                actionLabel: actionLabel,
                sessionKey: sessionKey)
        case WatchPromptNotificationBridge.actionSecondaryIdentifier:
            let actionId = (userInfo[WatchPromptNotificationBridge.actionSecondaryIDKey] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !actionId.isEmpty else { return nil }
            let actionLabel = userInfo[WatchPromptNotificationBridge.actionSecondaryLabelKey] as? String
            return PendingWatchPromptAction(
                promptId: promptId,
                actionId: actionId,
                actionLabel: actionLabel,
                sessionKey: sessionKey)
        default:
            break
        }

        guard response.actionIdentifier.hasPrefix(WatchPromptNotificationBridge.actionIdentifierPrefix) else {
            return nil
        }
        let indexString = String(
            response.actionIdentifier.dropFirst(WatchPromptNotificationBridge.actionIdentifierPrefix.count))
        guard let actionIndex = Int(indexString), actionIndex >= 0 else {
            return nil
        }
        let actionIdKey = WatchPromptNotificationBridge.actionIDKey(index: actionIndex)
        let actionLabelKey = WatchPromptNotificationBridge.actionLabelKey(index: actionIndex)
        let actionId = (userInfo[actionIdKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !actionId.isEmpty else {
            return nil
        }
        let actionLabel = userInfo[actionLabelKey] as? String
        return PendingWatchPromptAction(
            promptId: promptId,
            actionId: actionId,
            actionLabel: actionLabel,
            sessionKey: sessionKey)
    }

    private static func parseExecApprovalPrompt(
        from response: UNNotificationResponse) -> PendingExecApprovalPrompt?
    {
        ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo)
    }

    private func routeWatchPromptAction(_ action: PendingWatchPromptAction) async {
        guard let appModel = self.resolvedAppModel() else {
            self.pendingWatchPromptActions.append(action)
            return
        }
        await appModel.handleMirroredWatchPromptAction(
            promptId: action.promptId,
            actionId: action.actionId,
            actionLabel: action.actionLabel,
            sessionKey: action.sessionKey)
        _ = await appModel.handleBackgroundRefreshWake(trigger: "watch_prompt_action")
    }

    private func routeExecApprovalPrompt(_ prompt: PendingExecApprovalPrompt) {
        guard let appModel = self.resolvedAppModel() else {
            self.pendingExecApprovalPrompts.append(prompt)
            return
        }
        Task { @MainActor in
            await appModel.presentExecApprovalNotificationPrompt(prompt)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void)
    {
        let userInfo = notification.request.content.userInfo
        if Self.isWatchPromptNotification(userInfo)
            || ExecApprovalNotificationBridge.shouldPresentNotification(userInfo: userInfo)
        {
            completionHandler([.banner, .list, .sound])
            return
        }
        completionHandler([])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void)
    {
        if let action = Self.parseWatchPromptAction(from: response) {
            Task { @MainActor [weak self] in
                guard let self else {
                    completionHandler()
                    return
                }
                await self.routeWatchPromptAction(action)
                completionHandler()
            }
            return
        }
        if let prompt = Self.parseExecApprovalPrompt(from: response) {
            Task { @MainActor [weak self] in
                guard let self else {
                    completionHandler()
                    return
                }
                self.routeExecApprovalPrompt(prompt)
                completionHandler()
            }
            return
        }
        completionHandler()
    }
}

enum WatchPromptNotificationBridge {
    static let typeKey = "openclaw.type"
    static let typeValue = "watch.prompt"
    static let promptIDKey = "openclaw.watch.promptId"
    static let sessionKeyKey = "openclaw.watch.sessionKey"
    static let actionPrimaryIDKey = "openclaw.watch.action.primary.id"
    static let actionPrimaryLabelKey = "openclaw.watch.action.primary.label"
    static let actionSecondaryIDKey = "openclaw.watch.action.secondary.id"
    static let actionSecondaryLabelKey = "openclaw.watch.action.secondary.label"
    static let actionPrimaryIdentifier = "openclaw.watch.action.primary"
    static let actionSecondaryIdentifier = "openclaw.watch.action.secondary"
    static let actionIdentifierPrefix = "openclaw.watch.action."
    static let actionIDKeyPrefix = "openclaw.watch.action.id."
    static let actionLabelKeyPrefix = "openclaw.watch.action.label."
    static let categoryPrefix = "openclaw.watch.prompt.category."

    @MainActor
    static func scheduleMirroredWatchPromptNotificationIfNeeded(
        invokeID: String,
        params: OpenClawWatchNotifyParams,
        sendResult: WatchNotificationSendResult) async
    {
        guard sendResult.queuedForDelivery || !sendResult.deliveredImmediately else { return }

        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty || !body.isEmpty else { return }
        guard await self.requestNotificationAuthorizationIfNeeded() else { return }

        let normalizedActions = (params.actions ?? []).compactMap { action -> OpenClawWatchAction? in
            let id = action.id.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = action.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !label.isEmpty else { return nil }
            return OpenClawWatchAction(id: id, label: label, style: action.style)
        }
        let displayedActions = Array(normalizedActions.prefix(4))

        let center = UNUserNotificationCenter.current()
        var categoryIdentifier = ""
        if !displayedActions.isEmpty {
            let categoryID = "\(self.categoryPrefix)\(invokeID)"
            let category = UNNotificationCategory(
                identifier: categoryID,
                actions: self.categoryActions(displayedActions),
                intentIdentifiers: [],
                options: [])
            await self.upsertNotificationCategory(category, center: center)
            categoryIdentifier = categoryID
        }

        var userInfo: [AnyHashable: Any] = [
            self.typeKey: self.typeValue,
        ]
        if let promptId = params.promptId?.trimmingCharacters(in: .whitespacesAndNewlines), !promptId.isEmpty {
            userInfo[self.promptIDKey] = promptId
        }
        if let sessionKey = params.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines), !sessionKey.isEmpty {
            userInfo[self.sessionKeyKey] = sessionKey
        }
        for (index, action) in displayedActions.enumerated() {
            userInfo[self.actionIDKey(index: index)] = action.id
            userInfo[self.actionLabelKey(index: index)] = action.label
            if index == 0 {
                userInfo[self.actionPrimaryIDKey] = action.id
                userInfo[self.actionPrimaryLabelKey] = action.label
            } else if index == 1 {
                userInfo[self.actionSecondaryIDKey] = action.id
                userInfo[self.actionSecondaryLabelKey] = action.label
            }
        }

        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "OpenClaw" : title
        content.body = body
        content.sound = .default
        content.userInfo = userInfo
        if !categoryIdentifier.isEmpty {
            content.categoryIdentifier = categoryIdentifier
        }
        if #available(iOS 15.0, *) {
            switch params.priority ?? .active {
            case .passive:
                content.interruptionLevel = .passive
            case .timeSensitive:
                content.interruptionLevel = .timeSensitive
            case .active:
                content.interruptionLevel = .active
            }
        }

        let request = UNNotificationRequest(
            identifier: "watch.prompt.\(invokeID)",
            content: content,
            trigger: nil)
        try? await self.addNotificationRequest(request, center: center)
    }

    static func actionIDKey(index: Int) -> String {
        "\(self.actionIDKeyPrefix)\(index)"
    }

    static func actionLabelKey(index: Int) -> String {
        "\(self.actionLabelKeyPrefix)\(index)"
    }

    private static func categoryActions(_ actions: [OpenClawWatchAction]) -> [UNNotificationAction] {
        actions.enumerated().map { index, action in
            let identifier: String = switch index {
            case 0:
                self.actionPrimaryIdentifier
            case 1:
                self.actionSecondaryIdentifier
            default:
                "\(self.actionIdentifierPrefix)\(index)"
            }
            return UNNotificationAction(
                identifier: identifier,
                title: action.label,
                options: self.notificationActionOptions(style: action.style))
        }
    }

    private static func notificationActionOptions(style: String?) -> UNNotificationActionOptions {
        switch style?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "destructive":
            [.destructive]
        case "foreground":
            // For mirrored watch actions, keep handling in background when possible.
            []
        default:
            []
        }
    }

    private static func requestNotificationAuthorizationIfNeeded() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await self.notificationAuthorizationStatus(center: center)
        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            let granted = await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if !granted { return false }
            let updatedStatus = await self.notificationAuthorizationStatus(center: center)
            if self.isAuthorizationStatusAllowed(updatedStatus) {
                // Refresh APNs registration immediately after the first permission grant so the
                // gateway can receive a push registration without requiring an app relaunch.
                await MainActor.run {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
            return self.isAuthorizationStatusAllowed(updatedStatus)
        case .denied:
            return false
        @unknown default:
            return false
        }
    }

    private static func isAuthorizationStatusAllowed(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied, .notDetermined:
            return false
        @unknown default:
            return false
        }
    }

    private static func notificationAuthorizationStatus(
        center: UNUserNotificationCenter) async -> UNAuthorizationStatus
    {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    private static func upsertNotificationCategory(
        _ category: UNNotificationCategory,
        center: UNUserNotificationCenter) async
    {
        await withCheckedContinuation { continuation in
            center.getNotificationCategories { categories in
                var updated = categories
                updated.update(with: category)
                center.setNotificationCategories(updated)
                continuation.resume()
            }
        }
    }

    private static func addNotificationRequest(
        _ request: UNNotificationRequest,
        center: UNUserNotificationCenter) async throws
    {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                ThrowingContinuationSupport.resumeVoid(continuation, error: error)
            }
        }
    }
}

extension NodeAppModel {
    func handleMirroredWatchPromptAction(
        promptId: String?,
        actionId: String,
        actionLabel: String?,
        sessionKey: String?) async
    {
        let normalizedActionID = actionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedActionID.isEmpty else { return }

        let normalizedPromptID = promptId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSessionKey = sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedActionLabel = actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines)

        let event = WatchQuickReplyEvent(
            replyId: UUID().uuidString,
            promptId: (normalizedPromptID?.isEmpty == false) ? normalizedPromptID! : "unknown",
            actionId: normalizedActionID,
            actionLabel: (normalizedActionLabel?.isEmpty == false) ? normalizedActionLabel : nil,
            sessionKey: (normalizedSessionKey?.isEmpty == false) ? normalizedSessionKey : nil,
            note: "source=ios.notification",
            sentAtMs: Int(Date().timeIntervalSince1970 * 1000),
            transport: "ios.notification")
        await self._bridgeConsumeMirroredWatchReply(event)
    }
}

@main
struct OpenClawApp: App {
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    @UIApplicationDelegateAdaptor(OpenClawAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Self.installUncaughtExceptionLogger()
        GatewaySettingsStore.bootstrapPersistence()
        let appModel = NodeAppModel()
        OpenClawAppModelRegistry.appModel = appModel
        _appModel = State(initialValue: appModel)
        _gatewayController = State(initialValue: GatewayConnectionController(appModel: appModel))
    }

    var body: some Scene {
        WindowGroup {
            RootCanvas()
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.gatewayController)
                .task {
                    self.appDelegate.appModel = self.appModel
                }
                .onOpenURL { url in
                    Task { await self.appModel.handleDeepLink(url: url) }
                }
                .onChange(of: self.scenePhase) { _, newValue in
                    self.appModel.setScenePhase(newValue)
                    self.gatewayController.setScenePhase(newValue)
                    self.appDelegate.scenePhaseChanged(newValue)
                }
        }
    }
}

extension OpenClawApp {
    private static func installUncaughtExceptionLogger() {
        NSLog("OpenClaw: installing uncaught exception handler")
        NSSetUncaughtExceptionHandler { exception in
            // Useful when the app hits NSExceptions from SwiftUI/WebKit internals; these do not
            // produce a normal Swift error backtrace.
            let reason = exception.reason ?? "(no reason)"
            NSLog("UNCAUGHT EXCEPTION: %@ %@", exception.name.rawValue, reason)
            for line in exception.callStackSymbols {
                NSLog("  %@", line)
            }
        }
    }
}
