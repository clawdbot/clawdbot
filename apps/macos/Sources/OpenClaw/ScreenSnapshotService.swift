import AppKit
import Foundation
import OpenClawKit
@preconcurrency import ScreenCaptureKit

@MainActor
final class ScreenSnapshotService {
    enum ScreenSnapshotError: LocalizedError {
        case noDisplays
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case encodeFailed(String)

        var errorDescription: String? {
            switch self {
            case .noDisplays:
                "No displays available for screen snapshot"
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .captureFailed(message):
                message
            case let .encodeFailed(message):
                message
            }
        }
    }

    func snapshot(
        screenIndex: Int?,
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat?) async throws
        -> (
            data: Data,
            format: OpenClawScreenSnapshotFormat,
            width: Int,
            height: Int,
            displayFrameId: String)
    {
        let format = format ?? .jpeg
        let normalized = Self.normalize(maxWidth: maxWidth, quality: quality, format: format)

        let content = try await SCShareableContent.current
        let displays = content.displays.sorted { $0.displayID < $1.displayID }
        guard !displays.isEmpty else {
            throw ScreenSnapshotError.noDisplays
        }

        let idx = screenIndex ?? 0
        guard idx >= 0, idx < displays.count else {
            throw ScreenSnapshotError.invalidScreenIndex(idx)
        }
        let display = displays[idx]
        let displayFrameId = try Self.displayFrameId(
            for: display,
            referenceWidth: normalized.maxWidth)

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        let targetSize = Self.targetSize(
            width: display.width,
            height: display.height,
            maxWidth: normalized.maxWidth)
        config.width = targetSize.width
        config.height = targetSize.height
        config.showsCursor = true

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config)
        } catch {
            throw ScreenSnapshotError.captureFailed("screen capture failed")
        }
        // Geometry is part of the coordinate contract. If it changed while the
        // pixels were captured, no stable frame exists to authorize later input.
        let finalDisplayFrameId = try Self.displayFrameId(
            for: display,
            referenceWidth: normalized.maxWidth)
        guard displayFrameId == finalDisplayFrameId else {
            throw ScreenSnapshotError.captureFailed("display changed during screen capture")
        }

        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        let data: Data
        switch format {
        case .png:
            guard let encoded = bitmap.representation(using: .png, properties: [:]) else {
                throw ScreenSnapshotError.encodeFailed("png encode failed")
            }
            data = encoded
        case .jpeg:
            guard let encoded = bitmap.representation(
                using: .jpeg,
                properties: [.compressionFactor: normalized.quality])
            else {
                throw ScreenSnapshotError.encodeFailed("jpeg encode failed")
            }
            data = encoded
        }

        return (
            data: data,
            format: format,
            width: cgImage.width,
            height: cgImage.height,
            displayFrameId: displayFrameId)
    }

    private static func displayFrameId(
        for display: SCDisplay,
        referenceWidth: Int) throws -> String
    {
        let bounds = CGDisplayBounds(display.displayID)
        let geometry = OpenClawComputerDisplayGeometry(
            originX: bounds.origin.x,
            originY: bounds.origin.y,
            widthPoints: bounds.width,
            heightPoints: bounds.height)
        let sourceWidth = Double(display.width)
        let sourceHeight = Double(display.height)
        guard OpenClawComputerInputGeometry.isValidMappingGeometry(
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            display: geometry)
        else {
            throw ScreenSnapshotError.noDisplays
        }
        return OpenClawComputerInputGeometry.displayFrameId(
            displayID: display.displayID,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            referenceWidth: referenceWidth,
            display: geometry)
    }

    private static func normalize(
        maxWidth: Int?,
        quality: Double?,
        format: OpenClawScreenSnapshotFormat)
        -> (maxWidth: Int, quality: Double)
    {
        let resolvedMaxWidth = maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? (format == .png ? 900 : 1600)
        let resolvedQuality = min(1.0, max(0.05, quality ?? 0.72))
        return (maxWidth: resolvedMaxWidth, quality: resolvedQuality)
    }

    private static func targetSize(width: Int, height: Int, maxWidth: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0, width > maxWidth else {
            return (width: width, height: height)
        }
        let scale = Double(maxWidth) / Double(width)
        let targetHeight = max(1, Int((Double(height) * scale).rounded()))
        return (width: maxWidth, height: targetHeight)
    }
}
