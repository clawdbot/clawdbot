import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import OSLog

@MainActor
final class CanvasManager {
    static let shared = CanvasManager()

    private static let logger = Logger(subsystem: "ai.openclaw", category: "CanvasManager")

    private var panelController: CanvasWindowController?
    private var panelSessionKey: String?

    private init() {}

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    /// Optional anchor provider (e.g. menu bar status item). If nil, Canvas anchors to the mouse cursor.
    var defaultAnchorProvider: (() -> NSRect?)?

    private nonisolated static let canvasRoot: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw/canvas", isDirectory: true)
    }()

    func show(
        sessionKey: String,
        path: String? = nil,
        placement: CanvasPlacement? = nil) throws -> String
    {
        try self.showDetailed(
            sessionKey: sessionKey,
            target: path,
            placement: placement).directory
    }

    func showDetailed(
        sessionKey: String,
        target: String? = nil,
        placement: CanvasPlacement? = nil) throws -> CanvasShowResult
    {
        Self.logger.debug(
            """
            showDetailed start session=\(sessionKey, privacy: .public) \
            hasTarget=\(target != nil) \
            placement=\(placement != nil)
            """)
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let normalizedTarget = target?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty
        let ensured = try ensureController(sessionKey: sessionKey)
        let controller = ensured.controller

        if !ensured.created {
            controller.presentAnchoredPanel(anchorProvider: anchorProvider)
            controller.applyPreferredPlacement(placement)

            // Existing session: only navigate when an explicit target was provided.
            if let normalizedTarget {
                controller.load(target: normalizedTarget)
                self.refreshDebugStatus()
                return self.makeShowResult(
                    directory: controller.directoryPath,
                    target: target,
                    effectiveTarget: normalizedTarget)
            }

            self.refreshDebugStatus()
            return CanvasShowResult(
                directory: controller.directoryPath,
                target: target,
                effectiveTarget: nil,
                status: .shown,
                url: nil)
        }

        controller.applyPreferredPlacement(placement)

        // New session: default to the local document root.
        let effectiveTarget = normalizedTarget ?? "/"
        Self.logger.debug("showDetailed showCanvas hasExplicitTarget=\(normalizedTarget != nil)")
        controller.showCanvas(path: effectiveTarget)
        Self.logger.debug("showDetailed showCanvas done")
        self.refreshDebugStatus()

        return self.makeShowResult(
            directory: controller.directoryPath,
            target: target,
            effectiveTarget: effectiveTarget)
    }

    func hide(sessionKey: String) {
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.panelSessionKey == session else { return }
        self.panelController?.hideCanvas()
    }

    func hideAll() {
        self.panelController?.hideCanvas()
    }

    func refreshDebugStatus() {
        guard let controller = panelController else { return }
        let enabled = AppStateStore.shared.debugPaneEnabled
        let mode = AppStateStore.shared.connectionMode
        let title: String?
        let subtitle: String?
        switch mode {
        case .remote:
            title = "Remote control"
            switch ControlChannel.shared.state {
            case .connected:
                subtitle = "Connected"
            case .connecting:
                subtitle = "Connecting…"
            case .disconnected:
                subtitle = "Disconnected"
            case let .degraded(message):
                subtitle = message.isEmpty ? "Degraded" : message
            }
        case .local:
            title = GatewayProcessManager.shared.status.label
            subtitle = mode.rawValue
        case .unconfigured:
            title = "Unconfigured"
            subtitle = mode.rawValue
        }
        controller.updateDebugStatus(enabled: enabled, title: title, subtitle: subtitle)
    }

    // MARK: - Anchoring

    private static func mouseAnchorProvider() -> NSRect? {
        let pt = NSEvent.mouseLocation
        return NSRect(x: pt.x, y: pt.y, width: 1, height: 1)
    }

    // MARK: - Helpers

    /// A session switch keeps the single-panel model by replacing the previous panel.
    private func ensureController(sessionKey: String) throws -> (controller: CanvasWindowController, created: Bool) {
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)

        if let controller = panelController, panelSessionKey == session {
            Self.logger.debug("ensureController reuse existing session=\(session, privacy: .public)")
            controller.onVisibilityChanged = { [weak self] visible in
                self?.onPanelVisibilityChanged?(visible)
            }
            return (controller, false)
        }

        Self.logger.debug("ensureController creating new session=\(session, privacy: .public)")
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil

        Self.logger.debug("ensureController ensure canvas root dir")
        try FileManager().createDirectory(at: Self.canvasRoot, withIntermediateDirectories: true)
        Self.logger.debug("ensureController init CanvasWindowController")
        let controller = try CanvasWindowController(
            sessionKey: session,
            root: Self.canvasRoot,
            presentation: .panel(anchorProvider: anchorProvider))
        Self.logger.debug("ensureController CanvasWindowController init done")
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.panelController = controller
        self.panelSessionKey = session
        return (controller, true)
    }

    private static func directURL(for target: String?) -> URL? {
        guard let target else { return nil }
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return nil }
        return scheme == "https" || scheme == "http" || CanvasScheme.allSchemes.contains(scheme)
            ? url
            : nil
    }

    private func makeShowResult(
        directory: String,
        target: String?,
        effectiveTarget: String) -> CanvasShowResult
    {
        if let url = Self.directURL(for: effectiveTarget) {
            return CanvasShowResult(
                directory: directory,
                target: target,
                effectiveTarget: effectiveTarget,
                status: .web,
                url: url.absoluteString)
        }

        let sessionDir = URL(fileURLWithPath: directory)
        let status = Self.localStatus(sessionDir: sessionDir, target: effectiveTarget)
        let host = sessionDir.lastPathComponent
        let canvasURL = CanvasScheme.makeURL(session: host, path: effectiveTarget)?.absoluteString
        return CanvasShowResult(
            directory: directory,
            target: target,
            effectiveTarget: effectiveTarget,
            status: status,
            url: canvasURL)
    }

    private static func localStatus(sessionDir: URL, target: String) -> CanvasShowStatus {
        let fm = FileManager()
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutQuery = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first
            .map(String.init) ?? trimmed
        var path = withoutQuery
        if path.hasPrefix("/") {
            path.removeFirst()
        }
        path = path.removingPercentEncoding ?? path

        // Root special-case: resolve an existing index document.
        if path.isEmpty {
            let a = sessionDir.appendingPathComponent("index.html", isDirectory: false)
            let b = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
            if fm.fileExists(atPath: a.path) || fm.fileExists(atPath: b.path) {
                return .ok
            }
            return .notFound
        }

        // Direct file or directory.
        var candidate = sessionDir.appendingPathComponent(path, isDirectory: false)
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: candidate.path, isDirectory: &isDir) {
            if isDir.boolValue {
                return Self.indexExists(in: candidate) ? .ok : .notFound
            }
            return .ok
        }

        // Directory index behavior ("/yolo" -> "yolo/index.html") if directory exists.
        if !path.isEmpty, !path.hasSuffix("/") {
            candidate = sessionDir.appendingPathComponent(path, isDirectory: true)
            if fm.fileExists(atPath: candidate.path, isDirectory: &isDir), isDir.boolValue {
                return Self.indexExists(in: candidate) ? .ok : .notFound
            }
        }

        return .notFound
    }

    private static func indexExists(in dir: URL) -> Bool {
        let fm = FileManager()
        let a = dir.appendingPathComponent("index.html", isDirectory: false)
        if fm.fileExists(atPath: a.path) {
            return true
        }
        let b = dir.appendingPathComponent("index.htm", isDirectory: false)
        return fm.fileExists(atPath: b.path)
    }
}
