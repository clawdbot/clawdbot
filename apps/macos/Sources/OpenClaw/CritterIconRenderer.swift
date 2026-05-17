import AppKit

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 18)

    struct Badge {
        let symbolName: String
        let prominence: IconState.BadgeProminence
    }

    private struct Canvas {
        let w: CGFloat
        let h: CGFloat
        let stepX: CGFloat
        let stepY: CGFloat
        let snapX: (CGFloat) -> CGFloat
        let snapY: (CGFloat) -> CGFloat
        let context: CGContext
    }

    private struct Geometry {
        let bodyRect: CGRect
        let leftArmRect: CGRect
        let rightArmRect: CGRect
        let leftEarRect: CGRect
        let rightEarRect: CGRect
        let antennaLineWidth: CGFloat
        let legW: CGFloat
        let legH: CGFloat
        let legSpacing: CGFloat
        let legStartX: CGFloat
        let legYBase: CGFloat
        let legLift: CGFloat
        let legHeightScale: CGFloat
        let eyeSize: CGSize
        let eyeY: CGFloat
        let eyeOffset: CGFloat

        init(canvas: Canvas, legWiggle: CGFloat, earWiggle: CGFloat, earScale: CGFloat) {
            let w = canvas.w
            let h = canvas.h
            let snapX = canvas.snapX
            let snapY = canvas.snapY

            let bodyW = snapX(w * 0.68)
            let bodyH = snapY(h * 0.68)
            let bodyX = snapX((w - bodyW) / 2)
            let bodyY = snapY(h * 0.24)

            let armSize = snapX(w * 0.2)
            let armY = snapY(bodyY + bodyH * 0.36)
            let leftArmRect = CGRect(
                x: snapX(bodyX - armSize * 0.62),
                y: armY,
                width: armSize,
                height: armSize)
            let rightArmRect = CGRect(
                x: snapX(bodyX + bodyW - armSize * 0.38),
                y: armY,
                width: armSize,
                height: armSize)

            let antennaW = snapX(w * 0.22)
            let antennaH = snapY(min(bodyH * 0.24 * earScale, h * 0.19))
            let antennaLineWidth = max(snapX(w * 0.095), canvas.stepX * 2) * min(1.2, 0.94 + earScale * 0.06)
            let antennaLift = snapY(earWiggle * 0.35)
            let leftEarRect = CGRect(
                x: snapX(bodyX + bodyW * 0.18 - antennaW * 0.35 - earWiggle * 0.28),
                y: snapY(bodyY + bodyH * 0.86 + antennaLift),
                width: antennaW,
                height: antennaH)
            let rightEarRect = CGRect(
                x: snapX(bodyX + bodyW * 0.82 - antennaW * 0.65 + earWiggle * 0.28),
                y: snapY(bodyY + bodyH * 0.86 - antennaLift),
                width: antennaW,
                height: antennaH)

            let legW = snapX(w * 0.15)
            let legH = snapY(h * 0.25)
            let legSpacing = snapX(w * 0.16)
            let legsWidth = snapX(2 * legW + legSpacing)
            let legStartX = snapX((w - legsWidth) / 2)
            let legLift = snapY(legH * 0.35 * legWiggle)
            let legYBase = snapY(bodyY - legH * 0.58)
            let legHeightScale = 1 - 0.12 * legWiggle

            let eyeSize = CGSize(
                width: snapX(bodyW * 0.15),
                height: snapY(bodyH * 0.2))
            let eyeY = snapY(bodyY + bodyH * 0.58)
            let eyeOffset = snapX(bodyW * 0.22)

            self.bodyRect = CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH)
            self.leftArmRect = leftArmRect
            self.rightArmRect = rightArmRect
            self.leftEarRect = leftEarRect
            self.rightEarRect = rightEarRect
            self.antennaLineWidth = antennaLineWidth
            self.legW = legW
            self.legH = legH
            self.legSpacing = legSpacing
            self.legStartX = legStartX
            self.legYBase = legYBase
            self.legLift = legLift
            self.legHeightScale = legHeightScale
            self.eyeSize = eyeSize
            self.eyeY = eyeY
            self.eyeOffset = eyeOffset
        }
    }

    private struct FaceOptions {
        let blink: CGFloat
        let eyesClosedLines: Bool
    }

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        earHoles: Bool = false,
        eyesClosedLines: Bool = false,
        badge: Badge? = nil) -> NSImage
    {
        guard let rep = self.makeBitmapRep() else {
            return NSImage(size: self.size)
        }
        rep.size = self.size

        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }

        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            return NSImage(size: self.size)
        }
        NSGraphicsContext.current = context
        context.imageInterpolation = .none
        context.cgContext.setShouldAntialias(true)

        let canvas = self.makeCanvas(for: rep, context: context)
        let geometry = Geometry(
            canvas: canvas,
            legWiggle: legWiggle,
            earWiggle: earWiggle,
            earScale: earHoles ? max(earScale, 1.2) : earScale)

        self.drawBody(in: canvas, geometry: geometry)
        let face = FaceOptions(
            blink: blink,
            eyesClosedLines: eyesClosedLines)
        self.drawFace(in: canvas, geometry: geometry, options: face)

        if let badge {
            self.drawBadge(badge, canvas: canvas)
        }

        let image = NSImage(size: size)
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
    }

    private static func makeBitmapRep() -> NSBitmapImageRep? {
        // Force a 36×36px backing store (2× for the 18pt logical canvas) so the menu bar icon stays crisp on Retina.
        let pixelsWide = 36
        let pixelsHigh = 36
        return NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelsWide,
            pixelsHigh: pixelsHigh,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: [],
            bytesPerRow: 0,
            bitsPerPixel: 0)
    }

    private static func makeCanvas(for rep: NSBitmapImageRep, context: NSGraphicsContext) -> Canvas {
        let stepX = self.size.width / max(CGFloat(rep.pixelsWide), 1)
        let stepY = self.size.height / max(CGFloat(rep.pixelsHigh), 1)
        let snapX: (CGFloat) -> CGFloat = { ($0 / stepX).rounded() * stepX }
        let snapY: (CGFloat) -> CGFloat = { ($0 / stepY).rounded() * stepY }

        let w = snapX(size.width)
        let h = snapY(size.height)

        return Canvas(
            w: w,
            h: h,
            stepX: stepX,
            stepY: stepY,
            snapX: snapX,
            snapY: snapY,
            context: context.cgContext)
    }

    private static func drawBody(in canvas: Canvas, geometry: Geometry) {
        canvas.context.setStrokeColor(NSColor.labelColor.cgColor)
        canvas.context.setLineWidth(geometry.antennaLineWidth)
        canvas.context.setLineCap(.round)
        canvas.context.setLineJoin(.round)

        let leftStart = CGPoint(
            x: canvas.snapX(geometry.bodyRect.minX + geometry.bodyRect.width * 0.34),
            y: canvas.snapY(geometry.bodyRect.maxY - geometry.antennaLineWidth * 0.22))
        let leftEnd = CGPoint(
            x: canvas.snapX(geometry.leftEarRect.minX),
            y: canvas.snapY(geometry.leftEarRect.maxY))
        let leftControl = CGPoint(
            x: canvas.snapX(geometry.leftEarRect.midX),
            y: canvas.snapY(geometry.leftEarRect.minY))
        let rightStart = CGPoint(
            x: canvas.snapX(geometry.bodyRect.maxX - geometry.bodyRect.width * 0.34),
            y: canvas.snapY(geometry.bodyRect.maxY - geometry.antennaLineWidth * 0.22))
        let rightEnd = CGPoint(
            x: canvas.snapX(geometry.rightEarRect.maxX),
            y: canvas.snapY(geometry.rightEarRect.maxY))
        let rightControl = CGPoint(
            x: canvas.snapX(geometry.rightEarRect.midX),
            y: canvas.snapY(geometry.rightEarRect.minY))

        let antennae = CGMutablePath()
        antennae.move(to: leftStart)
        antennae.addQuadCurve(to: leftEnd, control: leftControl)
        antennae.move(to: rightStart)
        antennae.addQuadCurve(to: rightEnd, control: rightControl)
        canvas.context.addPath(antennae)
        canvas.context.strokePath()

        canvas.context.setFillColor(NSColor.labelColor.cgColor)

        for i in 0..<2 {
            let x = geometry.legStartX + CGFloat(i) * (geometry.legW + geometry.legSpacing)
            let lift = i % 2 == 0 ? geometry.legLift : -geometry.legLift
            let rect = CGRect(
                x: x,
                y: geometry.legYBase + lift,
                width: geometry.legW,
                height: geometry.legH * geometry.legHeightScale)
            canvas.context.addPath(CGPath(
                roundedRect: rect,
                cornerWidth: geometry.legW * 0.34,
                cornerHeight: geometry.legW * 0.34,
                transform: nil))
        }

        canvas.context.addEllipse(in: geometry.leftArmRect)
        canvas.context.addEllipse(in: geometry.rightArmRect)
        canvas.context.addEllipse(in: geometry.bodyRect)
        canvas.context.fillPath()
    }

    private static func drawFace(
        in canvas: Canvas,
        geometry: Geometry,
        options: FaceOptions)
    {
        canvas.context.saveGState()
        canvas.context.setBlendMode(.clear)

        let leftCenter = CGPoint(
            x: canvas.snapX(canvas.w / 2 - geometry.eyeOffset),
            y: canvas.snapY(geometry.eyeY))
        let rightCenter = CGPoint(
            x: canvas.snapX(canvas.w / 2 + geometry.eyeOffset),
            y: canvas.snapY(geometry.eyeY))

        if options.eyesClosedLines {
            let lineW = canvas.snapX(geometry.eyeSize.width * 1.15)
            let lineH = canvas.snapY(max(canvas.stepY * 2, geometry.bodyRect.height * 0.06))
            let corner = canvas.snapX(lineH * 0.6)
            let leftRect = CGRect(
                x: canvas.snapX(leftCenter.x - lineW / 2),
                y: canvas.snapY(leftCenter.y - lineH / 2),
                width: lineW,
                height: lineH)
            let rightRect = CGRect(
                x: canvas.snapX(rightCenter.x - lineW / 2),
                y: canvas.snapY(rightCenter.y - lineH / 2),
                width: lineW,
                height: lineH)
            canvas.context.addPath(CGPath(
                roundedRect: leftRect,
                cornerWidth: corner,
                cornerHeight: corner,
                transform: nil))
            canvas.context.addPath(CGPath(
                roundedRect: rightRect,
                cornerWidth: corner,
                cornerHeight: corner,
                transform: nil))
        } else {
            let eyeOpen = max(0.05, 1 - options.blink)
            let eyeH = canvas.snapY(geometry.eyeSize.height * eyeOpen)
            let leftRect = CGRect(
                x: canvas.snapX(leftCenter.x - geometry.eyeSize.width / 2),
                y: canvas.snapY(leftCenter.y - eyeH / 2),
                width: geometry.eyeSize.width,
                height: eyeH)
            let rightRect = CGRect(
                x: canvas.snapX(rightCenter.x - geometry.eyeSize.width / 2),
                y: canvas.snapY(rightCenter.y - eyeH / 2),
                width: geometry.eyeSize.width,
                height: eyeH)

            canvas.context.addEllipse(in: leftRect)
            canvas.context.addEllipse(in: rightRect)
        }

        canvas.context.fillPath()
        canvas.context.restoreGState()
    }

    private static func drawBadge(_ badge: Badge, canvas: Canvas) {
        let strength: CGFloat = switch badge.prominence {
        case .primary: 1.0
        case .secondary: 0.58
        case .overridden: 0.85
        }

        // Bigger, higher-contrast badge:
        // - Increase diameter so tool activity is noticeable.
        // - Draw a filled "puck", then knock out the symbol shape (transparent hole).
        //   This reads better in template-rendered menu bar icons than tiny monochrome glyphs.
        let diameter = canvas.snapX(canvas.w * 0.52 * (0.92 + 0.08 * strength)) // ~9–10pt on an 18pt canvas
        let margin = canvas.snapX(max(0.45, canvas.w * 0.03))
        let rect = CGRect(
            x: canvas.snapX(canvas.w - diameter - margin),
            y: canvas.snapY(margin),
            width: diameter,
            height: diameter)

        canvas.context.saveGState()
        canvas.context.setShouldAntialias(true)

        // Clear the underlying pixels so the badge stays readable over the critter.
        canvas.context.saveGState()
        canvas.context.setBlendMode(.clear)
        canvas.context.addEllipse(in: rect.insetBy(dx: -1.0, dy: -1.0))
        canvas.context.fillPath()
        canvas.context.restoreGState()

        let fillAlpha: CGFloat = min(1.0, 0.36 + 0.24 * strength)
        let strokeAlpha: CGFloat = min(1.0, 0.78 + 0.22 * strength)

        canvas.context.setFillColor(NSColor.labelColor.withAlphaComponent(fillAlpha).cgColor)
        canvas.context.addEllipse(in: rect)
        canvas.context.fillPath()

        canvas.context.setStrokeColor(NSColor.labelColor.withAlphaComponent(strokeAlpha).cgColor)
        canvas.context.setLineWidth(max(1.25, canvas.snapX(canvas.w * 0.075)))
        canvas.context.strokeEllipse(in: rect.insetBy(dx: 0.45, dy: 0.45))

        if let base = NSImage(systemSymbolName: badge.symbolName, accessibilityDescription: nil) {
            let pointSize = max(7.0, diameter * 0.82)
            let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .black)
            let symbol = base.withSymbolConfiguration(config) ?? base
            symbol.isTemplate = true

            let symbolRect = rect.insetBy(dx: diameter * 0.17, dy: diameter * 0.17)
            canvas.context.saveGState()
            canvas.context.setBlendMode(.clear)
            symbol.draw(
                in: symbolRect,
                from: .zero,
                operation: .sourceOver,
                fraction: 1,
                respectFlipped: true,
                hints: nil)
            canvas.context.restoreGState()
        }

        canvas.context.restoreGState()
    }
}
