import AppKit
import CoreGraphics
import Foundation
import PeekabooAutomationKit
import PeekabooFoundation
import SwiftUI

enum QuickChatWindowActivationPolicy: Equatable, Sendable {
    case regular
    case accessory
    case prohibited
    case unknown
}

struct QuickChatWindowCandidateInput: Equatable, Sendable {
    let windowID: Int
    let processID: Int32
    let bundleIdentifier: String?
    let appName: String
    let title: String
    let bounds: CGRect
    let activationPolicy: QuickChatWindowActivationPolicy
    let isRenderable: Bool
}

struct QuickChatWindowCandidate: Equatable, Sendable, Identifiable {
    var id: Int {
        self.windowID
    }

    let windowID: Int
    let processID: Int32
    let bundleIdentifier: String?
    let appName: String
    let title: String
    let bounds: CGRect
}

enum QuickChatWindowPickerLogic {
    static func filterCandidates(
        _ inputs: [QuickChatWindowCandidateInput],
        ownProcessID: Int32,
        ownBundleIdentifier: String?,
        excludedWindowIDs: Set<Int>) -> [QuickChatWindowCandidate]
    {
        inputs.compactMap { input in
            guard input.isRenderable,
                  input.activationPolicy == .regular,
                  input.processID != ownProcessID,
                  input.bundleIdentifier == nil || input.bundleIdentifier != ownBundleIdentifier,
                  !excludedWindowIDs.contains(input.windowID)
            else { return nil }
            return QuickChatWindowCandidate(
                windowID: input.windowID,
                processID: input.processID,
                bundleIdentifier: input.bundleIdentifier,
                appName: input.appName,
                title: input.title,
                bounds: input.bounds)
        }
    }

    /// Candidate order is CGWindowList front-to-back order; the first hit is topmost.
    static func hitTest(_ candidates: [QuickChatWindowCandidate], at point: CGPoint) -> QuickChatWindowCandidate? {
        candidates.first(where: { $0.bounds.contains(point) })
    }

    static func labelText(appName: String, title: String) -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty, trimmedTitle != appName else { return appName }
        return "\(appName) — \(trimmedTitle)"
    }
}

private enum QuickChatCapturePickerMode {
    case window
    case area
}

private final class QuickChatWindowPickerPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }
}

@MainActor
final class QuickChatWindowPicker {
    typealias InteractionHandler = @MainActor (Bool) -> Void
    typealias SendAcceptedHandler = @MainActor () -> Void
    typealias PermissionStatusProvider = @MainActor () async -> Bool
    typealias PermissionGrantProvider = @MainActor () async -> Void

    private let model: QuickChatModel
    private let onInteractionChanged: InteractionHandler
    private let onSendAccepted: SendAcceptedHandler
    private let applicationService: any ApplicationServiceProtocol
    private let windowService: any WindowManagementServiceProtocol
    private let screenCaptureService: any ScreenCaptureServiceProtocol
    private let permissionStatusProvider: PermissionStatusProvider
    private let permissionGrantProvider: PermissionGrantProvider

    private var panels: [QuickChatWindowPickerPanel] = []
    private var escapeMonitor: Any?
    private var operationID = UUID()
    private var captureTask: Task<Void, Never>?
    private var discoveryTask: Task<[QuickChatWindowCandidate], Error>?
    private var activePipelineID: UUID?
    private(set) var isInteractionActive = false

    init(
        model: QuickChatModel,
        onInteractionChanged: @escaping InteractionHandler,
        onSendAccepted: @escaping SendAcceptedHandler,
        applicationService: (any ApplicationServiceProtocol)? = nil,
        windowService: (any WindowManagementServiceProtocol)? = nil,
        screenCaptureService: (any ScreenCaptureServiceProtocol)? = nil,
        permissionStatusProvider: @escaping PermissionStatusProvider = {
            await PermissionManager.status([.screenRecording])[.screenRecording] == true
        },
        permissionGrantProvider: @escaping PermissionGrantProvider = {
            _ = await PermissionManager.ensure([.screenRecording], interactive: true)
        })
    {
        let logging = LoggingService(subsystem: "ai.openclaw.quickchat-picker")
        let feedbackClient: any AutomationFeedbackClient = NoopAutomationFeedbackClient()
        let applications = applicationService ?? ApplicationService(feedbackClient: feedbackClient)

        self.model = model
        self.onInteractionChanged = onInteractionChanged
        self.onSendAccepted = onSendAccepted
        self.applicationService = applications
        self.windowService = windowService ?? WindowManagementService(
            applicationService: applications,
            feedbackClient: feedbackClient)
        self.screenCaptureService = screenCaptureService ?? ScreenCaptureService(loggingService: logging)
        self.permissionStatusProvider = permissionStatusProvider
        self.permissionGrantProvider = permissionGrantProvider
    }

    func beginWindow() async {
        await self.begin(mode: .window)
    }

    func beginArea() async {
        await self.begin(mode: .area)
    }

    private func begin(mode: QuickChatCapturePickerMode) async {
        guard !self.isInteractionActive, self.captureTask == nil, self.model.canCaptureWindow else { return }
        let operationID = UUID()
        self.operationID = operationID
        self.isInteractionActive = true
        self.onInteractionChanged(true)

        guard await self.permissionStatusProvider() else {
            guard self.operationID == operationID else { return }
            await self.requestScreenRecordingPermission(mode: mode)
            // The modal alert suspends this task; a dismissal/reopen meanwhile owns the
            // interaction now, and finishing here would tear down the newer picker.
            guard self.operationID == operationID else { return }
            self.finishInteraction()
            return
        }
        // The permission check above suspends; a dismissal/reopen during it may have
        // taken over the interaction. Re-validate before installing any picker chrome
        // so a cancelled operation cannot strand full-screen area overlays.
        guard self.operationID == operationID, self.isInteractionActive, !Task.isCancelled else {
            return
        }

        if mode == .area {
            guard self.showAreaOverlays() else {
                self.model.setCaptureFailure()
                self.finishInteraction()
                return
            }
            return
        }

        do {
            // Track discovery so cancel() stops the scan instead of letting it run out
            // its per-application timeouts (and stack under a reopened picker).
            self.discoveryTask?.cancel()
            let discovery = Task { try await self.loadCandidates() }
            self.discoveryTask = discovery
            let candidates = try await discovery.value
            guard self.operationID == operationID, self.isInteractionActive, !Task.isCancelled else { return }
            guard !candidates.isEmpty else {
                self.model.setCaptureFailure()
                self.finishInteraction()
                return
            }
            self.showOverlays(candidates: candidates)
        } catch is CancellationError {
            // cancel() already restored the UI state.
        } catch {
            guard self.operationID == operationID else { return }
            self.model.setCaptureFailure()
            self.finishInteraction()
        }
    }

    func cancel() {
        self.operationID = UUID()
        self.discoveryTask?.cancel()
        self.discoveryTask = nil
        if let captureTask = self.captureTask {
            captureTask.cancel()
            self.captureTask = nil
        }
        if let pipelineID = self.activePipelineID {
            self.activePipelineID = nil
            self.model.cancelCapturePipeline(pipelineID)
        }
        self.finishInteraction()
    }

    private func requestScreenRecordingPermission(mode: QuickChatCapturePickerMode) async {
        let alert = NSAlert()
        alert.messageText = mode == .window
            ? String(localized: "Allow OpenClaw to capture windows")
            : String(localized: "Allow OpenClaw to capture a screen area")
        alert.informativeText = String(localized: "Sending a screenshot uses macOS Screen Recording access.")
        alert.addButton(withTitle: String(localized: "Grant Access"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        // This alert is user-initiated; only its affirmative action may trigger TCC.
        if alert.runModal() == .alertFirstButtonReturn {
            await self.permissionGrantProvider()
        }
    }

    private func loadCandidates() async throws -> [QuickChatWindowCandidate] {
        let zOrderSnapshot = try await WindowListMapper.shared.snapshot(forceRefresh: true)
        let zOrder = Dictionary(
            uniqueKeysWithValues: zOrderSnapshot.cgWindows.enumerated().map { ($0.element.windowID, $0.offset) })
        let applications = try await self.applicationService.listApplications().data.applications
        var inputs: [QuickChatWindowCandidateInput] = []

        let ownProcessID = getpid()
        for application in applications {
            // Only regular apps can contribute picker candidates; querying accessory or
            // prohibited processes just burns their per-request timeout.
            let policy = Self.activationPolicy(application.activationPolicy)
            guard policy == .regular, application.processIdentifier != ownProcessID else { continue }
            try Task.checkCancellation()
            guard let output = try? await self.applicationService.listWindows(
                for: "PID:\(application.processIdentifier)",
                timeout: 1)
            else { continue }
            for window in output.data.windows {
                inputs.append(QuickChatWindowCandidateInput(
                    windowID: window.windowID,
                    processID: application.processIdentifier,
                    bundleIdentifier: application.bundleIdentifier,
                    appName: application.name,
                    title: window.title,
                    bounds: window.bounds,
                    activationPolicy: policy,
                    isRenderable: WindowFiltering.isRenderable(window, mode: .capture)))
            }
        }

        let excludedWindowIDs = Set(NSApp.windows.map(\.windowNumber))
        let filtered = QuickChatWindowPickerLogic.filterCandidates(
            inputs,
            ownProcessID: getpid(),
            ownBundleIdentifier: Bundle.main.bundleIdentifier,
            excludedWindowIDs: excludedWindowIDs)
        return filtered.enumerated().sorted { lhs, rhs in
            let left = zOrder[CGWindowID(lhs.element.windowID)] ?? (Int.max / 2 + lhs.offset)
            let right = zOrder[CGWindowID(rhs.element.windowID)] ?? (Int.max / 2 + rhs.offset)
            return left < right
        }.map(\.element)
    }

    private func showOverlays(candidates: [QuickChatWindowCandidate]) {
        self.tearDownOverlays()
        let desktopTop = NSScreen.screens.first?.frame.maxY ?? 0

        for screen in NSScreen.screens {
            let cgScreenFrame = CGRect(
                x: screen.frame.minX,
                y: desktopTop - screen.frame.maxY,
                width: screen.frame.width,
                height: screen.frame.height)
            let localCandidates = candidates.compactMap { candidate -> QuickChatWindowCandidate? in
                let clipped = candidate.bounds.intersection(cgScreenFrame)
                guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
                return QuickChatWindowCandidate(
                    windowID: candidate.windowID,
                    processID: candidate.processID,
                    bundleIdentifier: candidate.bundleIdentifier,
                    appName: candidate.appName,
                    title: candidate.title,
                    bounds: CGRect(
                        x: clipped.minX - cgScreenFrame.minX,
                        y: clipped.minY - cgScreenFrame.minY,
                        width: clipped.width,
                        height: clipped.height))
            }

            let panel = QuickChatWindowPickerPanel(
                contentRect: screen.frame,
                styleMask: [.nonactivatingPanel, .borderless],
                backing: .buffered,
                defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.level = NSWindow.Level(rawValue: max(
                NSWindow.Level.screenSaver.rawValue,
                NSWindow.Level.floating.rawValue))
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
            panel.hidesOnDeactivate = false
            panel.isFloatingPanel = true
            panel.isExcludedFromWindowsMenu = true
            panel.ignoresMouseEvents = false
            panel.contentView = NSHostingView(rootView: QuickChatWindowPickerView(
                candidates: localCandidates,
                onSelect: { [weak self] candidate in self?.select(candidate) },
                onCancel: { [weak self] in self?.cancel() }))
            self.panels.append(panel)
            panel.makeKeyAndOrderFront(nil)
        }

        self.installEscapeMonitor()
    }

    private func showAreaOverlays() -> Bool {
        self.tearDownOverlays()
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return false }

        let displays = screens.compactMap { screen -> (NSScreen, CGRect)? in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
                return nil
            }
            let bounds = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
            guard bounds.width > 0, bounds.height > 0 else { return nil }
            return (screen, bounds)
        }
        guard displays.count == screens.count else { return false }

        for (screen, displayBounds) in displays {
            let screenFrame = screen.frame
            let panel = QuickChatWindowPickerPanel(
                contentRect: screenFrame,
                styleMask: [.nonactivatingPanel, .borderless],
                backing: .buffered,
                defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.level = NSWindow.Level(rawValue: max(
                NSWindow.Level.screenSaver.rawValue,
                NSWindow.Level.floating.rawValue))
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
            panel.hidesOnDeactivate = false
            panel.isFloatingPanel = true
            panel.isExcludedFromWindowsMenu = true
            panel.ignoresMouseEvents = false
            panel.acceptsMouseMovedEvents = true
            panel.contentView = QuickChatAreaPickerView(
                frame: CGRect(origin: .zero, size: screenFrame.size),
                onSelect: { [weak self] localRect in
                    self?.selectArea(
                        localRect: localRect,
                        screenFrame: screenFrame,
                        displayBounds: displayBounds)
                },
                onCancel: { [weak self] in self?.cancel() })
            self.panels.append(panel)
            panel.makeKeyAndOrderFront(nil)
        }

        self.installEscapeMonitor()
        return true
    }

    private func installEscapeMonitor() {
        self.escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            Task { @MainActor in self?.cancel() }
            return nil
        }
    }

    private func select(_ candidate: QuickChatWindowCandidate) {
        guard self.isInteractionActive, self.captureTask == nil,
              let presentationID = self.model.activePresentationID,
              let pipelineID = self.model.beginCapturePipeline()
        else { return }
        self.activePipelineID = pipelineID
        let operationID = self.operationID
        // Overlays must be gone before capture or the screenshot can include picker chrome.
        self.finishInteraction(invalidateOperation: false)

        self.captureTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .milliseconds(80))
                guard self.operationID == operationID,
                      self.model.activePresentationID == presentationID,
                      !Task.isCancelled
                else {
                    // Guard failure implies cancel() ran: it already reset the pipeline state,
                    // and a newer pipeline may hold .sending now — do not touch the model here.
                    self.clearCaptureTask(for: operationID)
                    return
                }
                _ = try await WindowListMapper.shared.snapshot(forceRefresh: true)
                let refreshed = try await self.windowService.listWindows(target: .windowId(candidate.windowID))
                guard let window = refreshed.first(where: { $0.windowID == candidate.windowID }),
                      WindowFiltering.isRenderable(window, mode: .capture)
                else { throw QuickChatWindowPickerError.windowUnavailable }
                let result = try await self.screenCaptureService.captureWindow(
                    windowID: CGWindowID(candidate.windowID))
                guard self.operationID == operationID,
                      self.model.activePresentationID == presentationID,
                      !Task.isCancelled
                else {
                    self.clearCaptureTask(for: operationID)
                    return
                }
                let accepted = await self.model.sendCapturedImage(
                    pipelineID: pipelineID,
                    data: result.imageData,
                    label: QuickChatWindowPickerLogic.labelText(
                        appName: candidate.appName,
                        title: candidate.title),
                    fileName: QuickChatModel.screenshotFileName(appName: candidate.appName))
                guard accepted,
                      self.operationID == operationID,
                      self.model.activePresentationID == presentationID
                else {
                    self.clearCaptureTask(for: operationID)
                    return
                }
                try? await Task.sleep(for: .seconds(0.45))
                let stillCurrent = self.operationID == operationID &&
                    self.model.activePresentationID == presentationID &&
                    self.model.sendState == .sent
                self.clearCaptureTask(for: operationID)
                if stillCurrent {
                    self.onSendAccepted()
                }
            } catch is CancellationError {
                self.clearCaptureTask(for: operationID)
            } catch {
                // Token-guarded: a stale operation's failure cannot touch a newer pipeline.
                self.model.failCapturePipeline(pipelineID)
                self.clearCaptureTask(for: operationID)
            }
        }
    }

    private func selectArea(localRect: CGRect, screenFrame: CGRect, displayBounds: CGRect) {
        guard self.isInteractionActive, self.captureTask == nil,
              let presentationID = self.model.activePresentationID,
              let pipelineID = self.model.beginCapturePipeline()
        else { return }
        self.activePipelineID = pipelineID
        let operationID = self.operationID
        let appKitRect = CGRect(
            x: screenFrame.minX + localRect.minX,
            y: screenFrame.minY + localRect.minY,
            width: localRect.width,
            height: localRect.height)
        let captureRect = QuickChatAreaPickerLogic.globalDisplayRect(
            appKitRect: appKitRect,
            screenFrame: screenFrame,
            displayBounds: displayBounds)

        // Keep the Quick Chat panel hidden while only the overlay windows disappear;
        // restoring it before capture would put the bar into the selected screenshot.
        self.tearDownOverlays()
        self.captureTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: .milliseconds(80))
                guard self.operationID == operationID,
                      self.model.activePresentationID == presentationID,
                      !Task.isCancelled
                else {
                    self.clearCaptureTask(for: operationID)
                    return
                }
                let result = try await self.screenCaptureService.captureArea(captureRect)
                guard self.operationID == operationID,
                      self.model.activePresentationID == presentationID,
                      !Task.isCancelled
                else {
                    self.clearCaptureTask(for: operationID)
                    return
                }
                // Pixels are captured; restore the bar now (kept hidden only so it could
                // not appear inside the selected region) so image processing and the
                // chat.send round-trip show progress instead of a vanished panel.
                self.finishInteraction(invalidateOperation: false)
                let accepted = await self.model.sendCapturedImage(
                    pipelineID: pipelineID,
                    data: result.imageData,
                    label: String(localized: "Selected area"),
                    fileName: "area-screenshot.jpg")
                guard accepted,
                      self.operationID == operationID,
                      self.model.activePresentationID == presentationID
                else {
                    self.clearCaptureTask(for: operationID)
                    if self.operationID == operationID {
                        self.finishInteraction(invalidateOperation: false)
                    }
                    return
                }
                self.finishInteraction(invalidateOperation: false)
                try? await Task.sleep(for: .seconds(0.45))
                let stillCurrent = self.operationID == operationID &&
                    self.model.activePresentationID == presentationID &&
                    self.model.sendState == .sent
                self.clearCaptureTask(for: operationID)
                if stillCurrent {
                    self.onSendAccepted()
                }
            } catch is CancellationError {
                self.clearCaptureTask(for: operationID)
            } catch {
                self.model.failCapturePipeline(pipelineID)
                self.clearCaptureTask(for: operationID)
                if self.operationID == operationID {
                    self.finishInteraction(invalidateOperation: false)
                }
            }
        }
    }

    /// A cancelled task can outlive its cancellation; only the operation that still owns
    /// the handle may clear it, or it would erase a newer capture's ability to be cancelled.
    private func clearCaptureTask(for operationID: UUID) {
        guard self.operationID == operationID else { return }
        self.captureTask = nil
    }

    private func finishInteraction(invalidateOperation: Bool = true) {
        if invalidateOperation { self.operationID = UUID() }
        self.tearDownOverlays()
        guard self.isInteractionActive else { return }
        self.isInteractionActive = false
        self.onInteractionChanged(false)
    }

    private func tearDownOverlays() {
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
        for panel in self.panels {
            panel.orderOut(nil)
        }
        self.panels.removeAll()
    }

    private static func activationPolicy(
        _ policy: ServiceApplicationActivationPolicy?) -> QuickChatWindowActivationPolicy
    {
        switch policy {
        case .regular: .regular
        case .accessory: .accessory
        case .prohibited: .prohibited
        case .unknown, nil: .unknown
        }
    }
}

private enum QuickChatWindowPickerError: Error {
    case windowUnavailable
}
