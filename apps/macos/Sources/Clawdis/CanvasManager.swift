import AppKit
import ClawdisIPC
import Foundation
import OSLog

@MainActor
final class CanvasManager {
    static let shared = CanvasManager()

    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "CanvasManager")

    private var panelController: CanvasWindowController?
    private var panelSessionKey: String?

    var onPanelVisibilityChanged: ((Bool) -> Void)?

    /// Optional anchor provider (e.g. menu bar status item). If nil, Canvas anchors to the mouse cursor.
    var defaultAnchorProvider: (() -> NSRect?)?

    private nonisolated static let canvasRoot: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Clawdis/canvas", isDirectory: true)
    }()

    func show(sessionKey: String, path: String? = nil, placement: CanvasPlacement? = nil) throws -> String {
        try self.showDetailed(sessionKey: sessionKey, target: path, placement: placement).directory
    }

    func showDetailed(
        sessionKey: String,
        target: String? = nil,
        placement: CanvasPlacement? = nil) throws -> CanvasShowResult
    {
        Self.logger.debug(
            "showDetailed start session=\(sessionKey, privacy: .public) target=\(target ?? "", privacy: .public) placement=\(placement != nil)")
        let anchorProvider = self.defaultAnchorProvider ?? Self.mouseAnchorProvider
        let session = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTarget = target?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty

        if let controller = self.panelController, self.panelSessionKey == session {
            Self.logger.debug("showDetailed reuse existing session=\(session, privacy: .public)")
            controller.onVisibilityChanged = { [weak self] visible in
                self?.onPanelVisibilityChanged?(visible)
            }
            controller.presentAnchoredPanel(anchorProvider: anchorProvider)
            controller.applyPreferredPlacement(placement)

            // Existing session: only navigate when an explicit target was provided.
            if let normalizedTarget {
                controller.load(target: normalizedTarget)
                return self.makeShowResult(
                    directory: controller.directoryPath,
                    target: target,
                    effectiveTarget: normalizedTarget)
            }

            return CanvasShowResult(
                directory: controller.directoryPath,
                target: target,
                effectiveTarget: nil,
                status: .shown,
                url: nil)
        }

        Self.logger.debug("showDetailed creating new session=\(session, privacy: .public)")
        self.panelController?.close()
        self.panelController = nil
        self.panelSessionKey = nil

        Self.logger.debug("showDetailed ensure canvas root dir")
        try FileManager.default.createDirectory(at: Self.canvasRoot, withIntermediateDirectories: true)
        Self.logger.debug("showDetailed init CanvasWindowController")
        let controller = try CanvasWindowController(
            sessionKey: session,
            root: Self.canvasRoot,
            presentation: .panel(anchorProvider: anchorProvider))
        Self.logger.debug("showDetailed CanvasWindowController init done")
        controller.onVisibilityChanged = { [weak self] visible in
            self?.onPanelVisibilityChanged?(visible)
        }
        self.panelController = controller
        self.panelSessionKey = session
        controller.applyPreferredPlacement(placement)

        // New session: default to "/" so the user sees either the welcome page or `index.html`.
        let effectiveTarget = normalizedTarget ?? "/"
        Self.logger.debug("showDetailed showCanvas effectiveTarget=\(effectiveTarget, privacy: .public)")
        controller.showCanvas(path: effectiveTarget)
        Self.logger.debug("showDetailed showCanvas done")

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

    func eval(sessionKey: String, javaScript: String) async throws -> String {
        _ = try self.show(sessionKey: sessionKey, path: nil)
        guard let controller = self.panelController else { return "" }
        return try await controller.eval(javaScript: javaScript)
    }

    func snapshot(sessionKey: String, outPath: String?) async throws -> String {
        _ = try self.show(sessionKey: sessionKey, path: nil)
        guard let controller = self.panelController else {
            throw NSError(domain: "Canvas", code: 21, userInfo: [NSLocalizedDescriptionKey: "canvas not available"])
        }
        return try await controller.snapshot(to: outPath)
    }

    // MARK: - Anchoring

    private static func mouseAnchorProvider() -> NSRect? {
        let pt = NSEvent.mouseLocation
        return NSRect(x: pt.x, y: pt.y, width: 1, height: 1)
    }

    // placement interpretation is handled by the window controller.

    // MARK: - Helpers

    private static func directURL(for target: String?) -> URL? {
        guard let target else { return nil }
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            if scheme == "https" || scheme == "http" || scheme == "file" { return url }
        }

        // Convenience: existing absolute *file* paths resolve as local files.
        // (Avoid treating Canvas routes like "/" as filesystem paths.)
        if trimmed.hasPrefix("/") {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: trimmed, isDirectory: &isDir), !isDir.boolValue {
                return URL(fileURLWithPath: trimmed)
            }
        }

        return nil
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
        let fm = FileManager.default
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutQuery = trimmed.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first
            .map(String.init) ?? trimmed
        var path = withoutQuery
        if path.hasPrefix("/") { path.removeFirst() }
        path = path.removingPercentEncoding ?? path

        // Root special-case: built-in shell page when no index exists.
        if path.isEmpty {
            let a = sessionDir.appendingPathComponent("index.html", isDirectory: false)
            let b = sessionDir.appendingPathComponent("index.htm", isDirectory: false)
            if fm.fileExists(atPath: a.path) || fm.fileExists(atPath: b.path) { return .ok }
            return Self.hasBundledA2UIShell() ? .a2uiShell : .welcome
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
        let fm = FileManager.default
        let a = dir.appendingPathComponent("index.html", isDirectory: false)
        if fm.fileExists(atPath: a.path) { return true }
        let b = dir.appendingPathComponent("index.htm", isDirectory: false)
        return fm.fileExists(atPath: b.path)
    }

    private static func hasBundledA2UIShell() -> Bool {
        guard let base = Bundle.module.resourceURL?.appendingPathComponent("CanvasA2UI", isDirectory: true) else {
            return false
        }
        let index = base.appendingPathComponent("index.html", isDirectory: false)
        return FileManager.default.fileExists(atPath: index.path)
    }
}
