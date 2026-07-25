import CryptoKit
import Foundation

/// A target display expressed in the global CoreGraphics point space (top-left
/// origin), which is exactly the space CGEvent mouse coordinates use.
public struct OpenClawComputerDisplayGeometry: Sendable, Equatable {
    public var originX: Double
    public var originY: Double
    public var widthPoints: Double
    public var heightPoints: Double

    public init(originX: Double, originY: Double, widthPoints: Double, heightPoints: Double) {
        self.originX = originX
        self.originY = originY
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
    }
}

/// Maps reference-screenshot pixel coordinates to global display points.
///
/// The model reasons over the `screen.snapshot` image whose pixel width equals
/// the captured width (ScreenSnapshotService downscales the capture source to
/// `min(refWidth, sourceWidth)`), so model coordinates live in captured-pixel
/// space. A single uniform factor (display point width / captured pixel width)
/// recovers global display points; aspect ratio is preserved so it also applies
/// to the vertical axis. Deriving the factor from the captured pixel width
/// rather than the display point width keeps clicks aligned on Retina modes
/// where physical pixels and logical points differ. Retina backing scale never
/// enters CGEvent coordinates, which are always points.
public enum OpenClawComputerInputGeometry {
    /// Stable opaque identity for one physical display geometry and reference
    /// scale. Screenshot and input paths independently derive this value so
    /// hot-plug/reindex/geometry/scale changes fail closed before coordinates can
    /// target pixels other than the frame the caller observed.
    public static func displayFrameId(
        displayID: UInt32,
        sourceWidth: Double,
        sourceHeight: Double,
        referenceWidth: Int,
        display: OpenClawComputerDisplayGeometry) -> String
    {
        let descriptor = [
            String(displayID),
            String(sourceWidth.bitPattern),
            String(sourceHeight.bitPattern),
            String(referenceWidth),
            String(display.originX.bitPattern),
            String(display.originY.bitPattern),
            String(display.widthPoints.bitPattern),
            String(display.heightPoints.bitPattern),
        ].joined(separator: "\u{0}")
        let digest = SHA256.hash(data: Data(descriptor.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "display-frame:v1:\(digest)"
    }

    /// Whether capture-source dimensions and their target display form a safe,
    /// finite coordinate mapping. Callers must reject invalid geometry before
    /// dispatching input; otherwise the fallback mapper collapses to an origin.
    public static func isValidMappingGeometry(
        sourceWidth: Double,
        sourceHeight: Double,
        display: OpenClawComputerDisplayGeometry) -> Bool
    {
        guard sourceWidth.isFinite,
              sourceHeight.isFinite,
              display.originX.isFinite,
              display.originY.isFinite,
              display.widthPoints.isFinite,
              display.heightPoints.isFinite
        else {
            return false
        }
        return sourceWidth > 0 &&
            sourceHeight > 0 &&
            display.widthPoints > 0 &&
            display.heightPoints > 0
    }

    /// The delivered screenshot pixel width for a reference width and the capture
    /// source dimensions. `sourceWidth`/`sourceHeight` are the capture source
    /// dimensions in the same units ScreenSnapshotService reads from the display.
    public static func capturedWidth(
        refWidth: Int?,
        sourceWidth: Double,
        sourceHeight: Double) -> Double
    {
        guard sourceWidth > 0 else { return 0 }
        // Node width cap: ScreenSnapshotService downscales the source to
        // min(refWidth, sourceWidth) and never upscales.
        let widthCap = refWidth.map { min(Double($0), sourceWidth) } ?? sourceWidth
        guard let refWidth, refWidth > 0, sourceHeight > 0 else { return widthCap }
        // The agent additionally caps the delivered screenshot's LONGEST edge to
        // the reference width (this turn and on later replay-sanitization), so a
        // portrait capture whose height exceeds the reference width is scaled down
        // uniformly. Mirror that scaling here so coordinates map against the same
        // pixel width the model actually saw. Landscape frames, whose longest edge
        // is the already-capped width, are unaffected.
        let cappedHeight = widthCap * sourceHeight / sourceWidth
        let longestEdge = max(widthCap, cappedHeight)
        let referenceWidth = Double(refWidth)
        guard longestEdge > referenceWidth else { return widthCap }
        return widthCap * referenceWidth / longestEdge
    }

    /// Converts a captured-pixel-space point to a global display point.
    /// `capturedWidthPixels` is the actual pixel width of the screenshot the
    /// model saw (see `capturedWidth`).
    public static func mapReferencePointToGlobal(
        x: Double,
        y: Double,
        capturedWidthPixels: Double,
        display: OpenClawComputerDisplayGeometry) -> (x: Double, y: Double)
    {
        guard capturedWidthPixels > 0, display.widthPoints > 0 else {
            return (x: display.originX, y: display.originY)
        }
        let scale = display.widthPoints / capturedWidthPixels
        return (
            x: display.originX + x * scale,
            y: display.originY + y * scale)
    }

    /// Clamps a global point to strictly inside the display. Coordinate mapping
    /// tolerates a small rounding epsilon at the edges, but the posted event must
    /// stay on the selected display: a far-edge point (e.g. x == captured width,
    /// which maps to originX + widthPoints) would otherwise fall on the adjacent
    /// screen the model never saw.
    public static func clampToDisplay(
        x: Double,
        y: Double,
        display: OpenClawComputerDisplayGeometry) -> (x: Double, y: Double)
    {
        let maxX = display.originX + max(0, display.widthPoints - 1)
        let maxY = display.originY + max(0, display.heightPoints - 1)
        return (
            x: min(max(x, display.originX), maxX),
            y: min(max(y, display.originY), maxY))
    }
}
