import SwiftUI

extension OpenClawMascotCanvas {
    static func drawAccessory(context: GraphicsContext, pose: OpenClawMascotPose) {
        guard pose.accessoryAmount > 0.01 else { return }
        var accessoryContext = context
        accessoryContext.opacity = Double(pose.accessoryAmount)
        accessoryContext.translateBy(x: 0, y: -14 * (1 - pose.accessoryAmount))

        switch pose.accessory {
        case .none:
            return
        case .nightcap:
            self.drawNightcap(context: accessoryContext)
        case .gradCap:
            self.drawGradCap(context: accessoryContext, bodyTilt: pose.bodyTilt)
        }
    }

    static func drawHardHat(context: GraphicsContext, amount: CGFloat) {
        guard amount > 0.01 else { return }
        var dome = Path()
        dome.move(to: CGPoint(x: 45, y: 15))
        dome.addCurve(
            to: CGPoint(x: 60, y: 3),
            control1: CGPoint(x: 47, y: 7),
            control2: CGPoint(x: 54, y: 3))
        dome.addCurve(
            to: CGPoint(x: 75, y: 15),
            control1: CGPoint(x: 66, y: 3),
            control2: CGPoint(x: 73, y: 7))
        dome.addLine(to: CGPoint(x: 45, y: 15))
        dome.closeSubpath()
        let brim = Path(roundedRect: CGRect(x: 41, y: 14, width: 38, height: 5), cornerRadius: 2)
        var hatContext = context
        hatContext.opacity = Double(amount)
        hatContext.translateBy(x: 60, y: 15 - 14 * (1 - amount))
        hatContext.rotate(by: .degrees(-5))
        hatContext.translateBy(x: -60, y: -15)
        hatContext.fill(
            dome,
            with: .linearGradient(
                Gradient(colors: [Color(red: 1, green: 0.84, blue: 0.35), self.hatAmber]),
                startPoint: CGPoint(x: 60, y: 3),
                endPoint: CGPoint(x: 60, y: 16)))
        let outline = Color(red: 0.72, green: 0.45, blue: 0.12).opacity(0.7)
        hatContext.stroke(dome, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
        hatContext.fill(brim, with: .color(self.hatAmber))
        hatContext.stroke(brim, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
    }

    private static func drawNightcap(context: GraphicsContext) {
        let capBlue = Color(red: 168 / 255, green: 199 / 255, blue: 232 / 255)
        let bandBlue = Color(red: 120 / 255, green: 163 / 255, blue: 207 / 255)
        let outline = Color(red: 72 / 255, green: 108 / 255, blue: 146 / 255).opacity(0.7)

        var cone = Path()
        cone.move(to: CGPoint(x: 47, y: 14))
        cone.addCurve(
            to: CGPoint(x: 86, y: 8),
            control1: CGPoint(x: 53, y: 1),
            control2: CGPoint(x: 70, y: 0))
        cone.addCurve(
            to: CGPoint(x: 72, y: 14),
            control1: CGPoint(x: 82, y: 11),
            control2: CGPoint(x: 77, y: 13))
        cone.closeSubpath()
        let brim = Path(roundedRect: CGRect(x: 44, y: 12, width: 32, height: 5), cornerRadius: 2)
        let pompom = Path(ellipseIn: CGRect(x: 83, y: 5, width: 6, height: 6))

        context.fill(cone, with: .color(capBlue))
        context.stroke(cone, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
        context.fill(brim, with: .color(bandBlue))
        context.stroke(brim, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
        context.fill(pompom, with: .color(capBlue))
        context.stroke(pompom, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
    }

    private static func drawGradCap(context: GraphicsContext, bodyTilt: CGFloat) {
        let capColor = Color(red: 28 / 255, green: 31 / 255, blue: 38 / 255)
        let outline = Color.black.opacity(0.75)

        var skullCap = Path()
        skullCap.move(to: CGPoint(x: 50, y: 8))
        skullCap.addLine(to: CGPoint(x: 70, y: 8))
        skullCap.addLine(to: CGPoint(x: 68, y: 15))
        skullCap.addLine(to: CGPoint(x: 52, y: 15))
        skullCap.closeSubpath()

        var board = Path()
        board.move(to: CGPoint(x: 60, y: 3))
        board.addLine(to: CGPoint(x: 77, y: 8))
        board.addLine(to: CGPoint(x: 60, y: 13))
        board.addLine(to: CGPoint(x: 43, y: 8))
        board.closeSubpath()

        context.fill(skullCap, with: .color(capColor))
        context.stroke(skullCap, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
        context.fill(board, with: .color(capColor))
        context.stroke(board, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))

        let tasselAngle = (26.565 + bodyTilt * 1.5) * .pi / 180
        let tasselEnd = CGPoint(
            x: 60 + cos(tasselAngle) * 13.416,
            y: 8 + sin(tasselAngle) * 13.416)
        var tassel = Path()
        tassel.move(to: CGPoint(x: 60, y: 8))
        tassel.addLine(to: tasselEnd)
        context.stroke(
            tassel,
            with: .color(self.hatAmber),
            style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
        context.fill(
            Path(ellipseIn: CGRect(x: 58.5, y: 6.5, width: 3, height: 3)),
            with: .color(self.hatAmber))
        context.fill(
            Path(ellipseIn: CGRect(x: tasselEnd.x - 2, y: tasselEnd.y - 2, width: 4, height: 4)),
            with: .color(self.hatAmber))
    }
}
