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

    private struct Antenna {
        let start: CGPoint
        let control: CGPoint
        let tip: CGPoint
    }

    private struct Geometry {
        let bodyRect: CGRect
        let armRadius: CGFloat
        let leftArmCenter: CGPoint
        let rightArmCenter: CGPoint
        let antennaLineWidth: CGFloat
        let leftAntenna: Antenna
        let rightAntenna: Antenna
        let legW: CGFloat
        let legH: CGFloat
        let legCenters: [CGFloat]
        let legYBase: CGFloat
        let legLift: CGFloat
        let eyeSize: CGSize
        let eyeY: CGFloat
        let eyeOffset: CGFloat

        init(canvas: Canvas, legWiggle: CGFloat, earWiggle: CGFloat, earScale: CGFloat, antennaDroop: CGFloat) {
            let w = canvas.w
            let h = canvas.h
            let cx = w / 2

            // Chubby near-circular body: the mascot's dominant shape must survive 18pt.
            let bodyW = w * 0.72
            let bodyH = h * 0.66
            let bodyX = (w - bodyW) / 2
            let bodyY = h * 0.19
            let bodyTop = bodyY + bodyH

            // Round arm nubs poking out at the sides, slightly below center like the mascot.
            let armRadius = w * 0.10
            let armY = bodyY + bodyH * 0.42
            self.armRadius = armRadius
            self.leftArmCenter = CGPoint(x: bodyX + armRadius * 0.1, y: armY)
            self.rightArmCenter = CGPoint(x: bodyX + bodyW - armRadius * 0.1, y: armY)

            // Stubby antennae curling outward; droop folds them down when asleep/paused.
            // Voice-wake earScale straightens and lengthens them instead of growing horns.
            let antennaLineWidth = w * 0.115
            let reach = 1 + (min(earScale, 1.9) - 1) * 0.6
            let wiggleShift = earWiggle * 0.28

            func antenna(side: CGFloat) -> Antenna {
                let start = CGPoint(x: cx + side * bodyW * 0.16, y: bodyTop - antennaLineWidth * 0.9)
                // Idle tips sit below the canvas clamp so the voice-wake reach has
                // real headroom; boosted antennae go taller AND steeper (x pulls
                // inward) or the perk would be invisible at 18pt.
                let upTip = CGPoint(
                    x: cx + side * bodyW * (0.40 - 0.20 * (reach - 1)) + side * wiggleShift,
                    y: min(bodyTop + h * 0.06 * reach + earWiggle * 0.2 * side, h - antennaLineWidth * 0.55))
                let upControl = CGPoint(
                    x: cx + side * bodyW * 0.22,
                    y: bodyTop + h * 0.075 * reach)
                let downTip = CGPoint(x: cx + side * bodyW * 0.52, y: bodyTop - h * 0.13)
                let downControl = CGPoint(x: cx + side * bodyW * 0.38, y: bodyTop + h * 0.04)
                let tip = CGPoint(
                    x: upTip.x + (downTip.x - upTip.x) * antennaDroop,
                    y: upTip.y + (downTip.y - upTip.y) * antennaDroop)
                let control = CGPoint(
                    x: upControl.x + (downControl.x - upControl.x) * antennaDroop,
                    y: upControl.y + (downControl.y - upControl.y) * antennaDroop)
                return Antenna(start: start, control: control, tip: tip)
            }
            self.leftAntenna = antenna(side: -1)
            self.rightAntenna = antenna(side: 1)
            self.antennaLineWidth = antennaLineWidth

            // Stubby legs tucked under the body; they must overlap the body so the
            // silhouette stays connected at menu bar size.
            let legW = w * 0.14
            let legH = h * 0.18
            self.legW = legW
            self.legH = legH
            self.legCenters = [cx - w * 0.13, cx + w * 0.13]
            self.legYBase = bodyY - legH * 0.5
            self.legLift = legH * 0.35 * legWiggle

            // Big friendly eyes just above center.
            self.eyeSize = CGSize(width: bodyW * 0.22, height: bodyH * 0.26)
            self.eyeY = bodyY + bodyH * 0.58
            self.eyeOffset = bodyW * 0.22

            self.bodyRect = CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH)
        }
    }

    private struct FaceOptions {
        let blink: CGFloat
        let eyesClosedLines: Bool
        let happyEyes: Bool
    }

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        antennaDroop: CGFloat = 0,
        eyesClosedLines: Bool = false,
        happyEyes: Bool = false,
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
            earScale: earScale,
            antennaDroop: antennaDroop)

        self.drawBody(in: canvas, geometry: geometry)
        let face = FaceOptions(
            blink: blink,
            eyesClosedLines: eyesClosedLines,
            happyEyes: happyEyes)
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
        let ctx = canvas.context

        // Antennae first so the body fill covers their roots.
        ctx.setStrokeColor(NSColor.labelColor.cgColor)
        ctx.setLineWidth(geometry.antennaLineWidth)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)

        let antennae = CGMutablePath()
        for antenna in [geometry.leftAntenna, geometry.rightAntenna] {
            antennae.move(to: antenna.start)
            antennae.addQuadCurve(to: antenna.tip, control: antenna.control)
        }
        ctx.addPath(antennae)
        ctx.strokePath()

        ctx.setFillColor(NSColor.labelColor.cgColor)

        for (i, legCenter) in geometry.legCenters.enumerated() {
            let lift = i % 2 == 0 ? geometry.legLift : -geometry.legLift
            let rect = CGRect(
                x: legCenter - geometry.legW / 2,
                y: geometry.legYBase + lift,
                width: geometry.legW,
                height: geometry.legH)
            ctx.addPath(CGPath(
                roundedRect: rect,
                cornerWidth: geometry.legW / 2,
                cornerHeight: geometry.legW / 2,
                transform: nil))
        }

        for center in [geometry.leftArmCenter, geometry.rightArmCenter] {
            ctx.addEllipse(in: CGRect(
                x: center.x - geometry.armRadius,
                y: center.y - geometry.armRadius,
                width: geometry.armRadius * 2,
                height: geometry.armRadius * 2))
        }

        ctx.addEllipse(in: geometry.bodyRect)
        ctx.fillPath()
    }

    private static func drawFace(
        in canvas: Canvas,
        geometry: Geometry,
        options: FaceOptions)
    {
        let ctx = canvas.context
        let leftCenter = CGPoint(x: canvas.w / 2 - geometry.eyeOffset, y: geometry.eyeY)
        let rightCenter = CGPoint(x: canvas.w / 2 + geometry.eyeOffset, y: geometry.eyeY)

        ctx.saveGState()
        ctx.setBlendMode(.clear)

        if options.happyEyes || options.eyesClosedLines {
            // Curved lids: happy "∩ ∩" for celebrations, sleepy "⌣ ⌣" while dozing.
            let radius = geometry.eyeSize.width * 0.62
            let lineWidth = max(canvas.stepY * 2, geometry.eyeSize.height * 0.34)
            ctx.setLineWidth(lineWidth)
            ctx.setLineCap(.round)
            for center in [leftCenter, rightCenter] {
                let arcCenter = CGPoint(
                    x: center.x,
                    y: center.y + (options.happyEyes ? -radius * 0.4 : radius * 0.55))
                let path = CGMutablePath()
                // Counterclockwise sweeps the short arc in this y-up context:
                // top half for "∩", bottom half for "⌣".
                path.addArc(
                    center: arcCenter,
                    radius: radius,
                    startAngle: options.happyEyes ? .pi * 0.12 : .pi * 1.12,
                    endAngle: options.happyEyes ? .pi * 0.88 : .pi * 1.88,
                    clockwise: false)
                ctx.addPath(path)
            }
            ctx.replacePathWithStrokedPath()
            ctx.fillPath()
            ctx.restoreGState()
            return
        }

        // Blink squeezes the eye toward a soft line so the face never vanishes mid-blink.
        let eyeOpen = max(0.22, 1 - options.blink)
        let eyeH = geometry.eyeSize.height * eyeOpen
        for center in [leftCenter, rightCenter] {
            ctx.addEllipse(in: CGRect(
                x: center.x - geometry.eyeSize.width / 2,
                y: center.y - eyeH / 2,
                width: geometry.eyeSize.width,
                height: eyeH))
        }
        ctx.fillPath()
        ctx.restoreGState()

        // Glossy glint inside each open eye, echoing the mascot's shiny pupils.
        // Skipped while blinking: a dot inside a near-closed lid reads as noise.
        if eyeH > geometry.eyeSize.height * 0.7 {
            let glintR = geometry.eyeSize.width * 0.26
            ctx.setFillColor(NSColor.labelColor.cgColor)
            for center in [leftCenter, rightCenter] {
                ctx.addEllipse(in: CGRect(
                    x: center.x - geometry.eyeSize.width * 0.22 - glintR,
                    y: center.y + geometry.eyeSize.height * 0.18 - glintR,
                    width: glintR * 2,
                    height: glintR * 2))
            }
            ctx.fillPath()
        }
    }

    private static func drawBadge(_ badge: Badge, canvas: Canvas) {
        let strength: CGFloat = switch badge.prominence {
        case .primary: 1.0
        case .secondary: 0.58
        case .overridden: 0.85
        }

        // Filled "puck" with the symbol knocked out (transparent hole): reads better
        // in template-rendered menu bar icons than tiny monochrome glyphs. Sized so
        // the critter behind it stays recognizable.
        let diameter = canvas.snapX(canvas.w * 0.46 * (0.92 + 0.08 * strength))
        let margin = canvas.snapX(max(0.45, canvas.w * 0.02))
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
