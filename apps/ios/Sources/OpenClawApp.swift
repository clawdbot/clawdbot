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
    var gatewayStableID: String?
}

private typealias PendingExecApprovalPrompt = ExecApprovalNotificationPrompt

@MainActor
enum OpenClawAppModelRegistry {
    static var appModel: NodeAppModel?
}

@MainActor
final class OpenClawAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "Push")
    private let backgroundWakeLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "BackgroundWake")
    private static var wakeRefreshTaskIdentifier: String {
        "\(appBundleIdentifier).bgrefresh"
    }

    private static var appBundleIdentifier: String {
        guard let bundleId = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleId.isEmpty
        else {
            return "ai.openclawfoundation.app"
        }

        return bundleId
    }

    private var backgroundWakeTask: Task<Bool, Never>?
    private var pendingAPNsDeviceToken: Data?
    private var pendingWatchPromptActions: [PendingWatchPromptAction] = []
    private var pendingExecApprovalPrompts: [PendingExecApprovalPrompt] = []
    private var pendingExecApprovalRequestedPushes: [ExecApprovalNotificationPrompt] = []
    private var pendingExecApprovalResolvedPushes: [ExecApprovalNotificationPrompt] = []
    private var pendingOpenURLs: [URL] = []

    weak var appModel: NodeAppModel? {
        didSet {
            guard let model = resolvedAppModel() else { return }
            if let token = pendingAPNsDeviceToken {
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
                            sessionKey: action.sessionKey,
                            gatewayStableID: action.gatewayStableID)
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
            if !self.pendingExecApprovalRequestedPushes.isEmpty {
                let pending = self.pendingExecApprovalRequestedPushes
                self.pendingExecApprovalRequestedPushes.removeAll()
                Task { @MainActor in
                    for push in pending {
                        _ = await model.handleExecApprovalRequestedRemotePush(push)
                    }
                }
            }
            if !self.pendingExecApprovalResolvedPushes.isEmpty {
                let pending = self.pendingExecApprovalResolvedPushes
                self.pendingExecApprovalResolvedPushes.removeAll()
                Task { @MainActor in
                    for push in pending {
                        _ = await model.handleExecApprovalResolvedRemotePush(push)
                    }
                }
            }
            if !self.pendingOpenURLs.isEmpty {
                let pending = self.pendingOpenURLs
                self.pendingOpenURLs.removeAll()
                Task { @MainActor in
                    for url in pending {
                        await self.handleOpenURL(url, model: model)
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

    func _test_wakeRefreshTaskIdentifier() -> String {
        Self.wakeRefreshTaskIdentifier
    }
    #endif

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool
    {
        GatewayDiagnostics.log("app delegate: didFinishLaunching")
        if self.appModel == nil {
            self.appModel = OpenClawAppModelRegistry.appModel
        }
        self.registerBackgroundWakeRefreshTask()
        let notificationCenter = UNUserNotificationCenter.current()
        notificationCenter.delegate = self
        ExecApprovalNotificationBridge.registerCategory(center: notificationCenter)
        Task { @MainActor in
            await self.registerForRemoteNotificationsIfEnrollmentReady(application)
        }
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool
    {
        guard DeepLinkParser.parse(url) != nil else { return false }
        guard let model = resolvedAppModel() else {
            self.pendingOpenURLs.append(url)
            return true
        }
        Task { @MainActor in
            await self.handleOpenURL(url, model: model)
        }
        return true
    }

    func handleOpenURL(_ url: URL, model: NodeAppModel) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case .agent, .dashboard:
            await model.handleDeepLink(url: url)
        case let .gateway(link):
            model.stageGatewaySetupLink(link)
        }
    }

    private func registerForRemoteNotificationsIfEnrollmentReady(_ application: UIApplication) async {
        guard NotificationServingPreference.isEnabled() else { return }
        guard !PushBuildConfig.current.usesOpenClawHostedRelay
            || PushEnrollmentConsent.disclosureAccepted
        else { return }
        guard await Self.isNotificationAuthorizationAllowed() else { return }
        application.registerForRemoteNotifications()
    }

    private static func isNotificationAuthorizationAllowed() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied, .notDetermined:
            return false
        @unknown default:
            return false
        }
    }

    func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        if let appModel = resolvedAppModel() {
            Task { @MainActor in
                appModel.updateAPNsDeviceToken(deviceToken)
            }
            return
        }

        self.pendingAPNsDeviceToken = deviceToken
    }

    func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        self.logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    func application(
        _: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void)
    {
        self.logger.info("APNs remote notification received keys=\(userInfo.keys.count, privacy: .public)")
        Task { @MainActor in
            if let push = ExecApprovalNotificationBridge.parseResolvedPush(userInfo: userInfo) {
                if let appModel = self.resolvedAppModel() {
                    let handled = await appModel.handleExecApprovalResolvedRemotePush(push)
                    completionHandler(handled ? .newData : .noData)
                } else {
                    self.pendingExecApprovalResolvedPushes.append(push)
                    completionHandler(.newData)
                }
                return
            }
            guard let appModel = self.resolvedAppModel() else {
                if let push = ExecApprovalNotificationBridge.parseRequestedPush(userInfo: userInfo) {
                    self.pendingExecApprovalRequestedPushes.append(push)
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
        let gatewayStableID = userInfo[WatchPromptNotificationBridge.gatewayStableIDKey] as? String

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
                sessionKey: sessionKey,
                gatewayStableID: gatewayStableID)
        case WatchPromptNotificationBridge.actionSecondaryIdentifier:
            let actionId = (userInfo[WatchPromptNotificationBridge.actionSecondaryIDKey] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !actionId.isEmpty else { return nil }
            let actionLabel = userInfo[WatchPromptNotificationBridge.actionSecondaryLabelKey] as? String
            return PendingWatchPromptAction(
                promptId: promptId,
                actionId: actionId,
                actionLabel: actionLabel,
                sessionKey: sessionKey,
                gatewayStableID: gatewayStableID)
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
            sessionKey: sessionKey,
            gatewayStableID: gatewayStableID)
    }

    private static func parseExecApprovalPrompt(
        from response: UNNotificationResponse) -> PendingExecApprovalPrompt?
    {
        ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: response.actionIdentifier,
            userInfo: response.notification.request.content.userInfo)
    }

    private func routeWatchPromptAction(_ action: PendingWatchPromptAction) async {
        guard let appModel = resolvedAppModel() else {
            self.pendingWatchPromptActions.append(action)
            return
        }
        await appModel.handleMirroredWatchPromptAction(
            promptId: action.promptId,
            actionId: action.actionId,
            actionLabel: action.actionLabel,
            sessionKey: action.sessionKey,
            gatewayStableID: action.gatewayStableID)
        _ = await appModel.handleBackgroundRefreshWake(trigger: "watch_prompt_action")
    }

    private func routeExecApprovalPrompt(_ prompt: PendingExecApprovalPrompt) {
        guard let appModel = resolvedAppModel() else {
            self.pendingExecApprovalPrompts.append(prompt)
            return
        }
        Task { @MainActor in
            await appModel.presentExecApprovalNotificationPrompt(prompt)
        }
    }

    func userNotificationCenter(
        _: UNUserNotificationCenter,
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
        _: UNUserNotificationCenter,
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
    static let gatewayStableIDKey = "openclaw.watch.gatewayStableID"
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
        gatewayStableID: String?,
        sendResult: WatchNotificationSendResult) async
    {
        guard sendResult.queuedForDelivery || !sendResult.deliveredImmediately else { return }

        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty || !body.isEmpty else { return }
        guard await self.isNotificationAuthorizationAllowed() else { return }

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
            let categoryID = "\(categoryPrefix)\(invokeID)"
            let category = UNNotificationCategory(
                identifier: categoryID,
                actions: categoryActions(displayedActions),
                intentIdentifiers: [],
                options: [])
            await upsertNotificationCategory(category, center: center)
            categoryIdentifier = categoryID
        }

        var userInfo: [AnyHashable: Any] = [
            typeKey: typeValue,
        ]
        if let promptId = params.promptId?.trimmingCharacters(in: .whitespacesAndNewlines), !promptId.isEmpty {
            userInfo[self.promptIDKey] = promptId
        }
        if let sessionKey = params.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines), !sessionKey.isEmpty {
            userInfo[self.sessionKeyKey] = sessionKey
        }
        if let gatewayStableID = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gatewayStableID.isEmpty
        {
            userInfo[self.gatewayStableIDKey] = gatewayStableID
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
        try? await addNotificationRequest(request, center: center)
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

    private static func isNotificationAuthorizationAllowed() async -> Bool {
        guard NotificationServingPreference.isEnabled() else { return false }
        let center = UNUserNotificationCenter.current()
        let status = await notificationAuthorizationStatus(center: center)
        return self.isAuthorizationStatusAllowed(status)
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
        sessionKey: String?,
        gatewayStableID: String?) async
    {
        let normalizedActionID = actionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedActionID.isEmpty else { return }

        let normalizedPromptID = promptId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSessionKey = sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedGatewayStableID = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedActionLabel = actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines)

        let event = WatchQuickReplyEvent(
            replyId: UUID().uuidString,
            promptId: (normalizedPromptID?.isEmpty == false) ? normalizedPromptID! : "unknown",
            actionId: normalizedActionID,
            actionLabel: (normalizedActionLabel?.isEmpty == false) ? normalizedActionLabel : nil,
            sessionKey: (normalizedSessionKey?.isEmpty == false) ? normalizedSessionKey : nil,
            gatewayStableID: (normalizedGatewayStableID?.isEmpty == false) ? normalizedGatewayStableID : nil,
            note: "source=ios.notification",
            sentAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            transport: "ios.notification")
        await _bridgeConsumeMirroredWatchReply(event)
    }
}

@main
struct OpenClawApp: App {
    @State private var appearanceModel: AppAppearanceModel
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    @UIApplicationDelegateAdaptor(OpenClawAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Self.installUncaughtExceptionLogger()
        GatewaySettingsStore.bootstrapPersistence()
        OpenClawType.installUIKitAppearance()
        let appModel = NodeAppModel()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openclaw-reset-onboarding") {
            // Reruns must exercise onboarding instead of saved pairing state.
            GatewayOnboardingReset.resetBeforeStartup(
                appModel: appModel,
                instanceId: GatewaySettingsStore.currentInstanceID())
        }
        if Self.screenshotModeEnabled {
            UIView.setAnimationsEnabled(false)
            UserDefaults.standard.set(true, forKey: "gateway.onboardingComplete")
            UserDefaults.standard.set(true, forKey: "gateway.hasConnectedOnce")
            UserDefaults.standard.set(true, forKey: "onboarding.quickSetupDismissed")
            appModel.enterScreenshotFixtureMode()
            if Self.screenshotNotificationGuidanceEnabled {
                appModel._debug_presentNotificationPermissionGuidancePromptForScreenshot()
            }
        }
        #endif
        OpenClawAppModelRegistry.appModel = appModel
        _appearanceModel = State(initialValue: AppAppearanceModel())
        _appModel = State(initialValue: appModel)
        _gatewayController = State(
            initialValue: GatewayConnectionController(
                appModel: appModel,
                startDiscovery: !Self.screenshotModeEnabled,
                deferDiscoveryUntilLocalNetworkRequest: true))
    }

    var body: some Scene {
        WindowGroup {
            RootTabs()
                .tint(OpenClawBrand.accent)
                .font(OpenClawType.body)
                .environment(self.appearanceModel)
                .preferredColorScheme(self.appearanceModel.preference.colorScheme)
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.gatewayController)
                .task {
                    self.appDelegate.appModel = self.appModel
                    self.applyWindowTint()
                    self.gatewayController.setScenePhase(self.scenePhase)
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: UIContentSizeCategory.didChangeNotification),
                    perform: { _ in
                        OpenClawType.refreshUIKitAppearance(in: Self.connectedWindows())
                    })
                .onOpenURL { url in
                    // SwiftUI owns normal scene delivery; the delegate also queues URLs
                    // that arrive before the scene has installed its model.
                    Task { await self.appDelegate.handleOpenURL(url, model: self.appModel) }
                }
                .onChange(of: self.scenePhase) { _, newValue in
                    self.appModel.setScenePhase(newValue)
                    self.gatewayController.setScenePhase(newValue)
                    self.appDelegate.scenePhaseChanged(newValue)
                    self.applyWindowTint()
                }
        }
    }

    private static var screenshotModeEnabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode")
        #else
        false
        #endif
    }

    private static var screenshotNotificationGuidanceEnabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-notification-guidance")
        #else
        false
        #endif
    }

    @MainActor
    private func applyWindowTint() {
        for window in Self.connectedWindows() {
            window.tintColor = OpenClawBrand.uiAccent
        }
    }

    @MainActor
    private static func connectedWindows() -> [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
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
