// Generates the clearly labelled synthetic JPEG frames used by
// `npm run synthetic-frames -w server` (web viewer testing without an iPhone).
// Usage: swift scripts/gen-synthetic-frames.swift server/scripts/synthetic-frames
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "server/scripts/synthetic-frames")
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let width = 480, height = 360, count = 16
let space = CGColorSpaceCreateDeviceRGB()

func text(_ ctx: CGContext, _ s: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat, color: NSColor, bold: Bool = true) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size),
        .foregroundColor: color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    ctx.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, ctx)
}

for i in 0..<count {
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("context") }
    let w = CGFloat(width), h = CGFloat(height)
    // Wall and floor (origin is bottom-left in CoreGraphics).
    ctx.setFillColor(NSColor(calibratedRed: 0.93, green: 0.90, blue: 0.85, alpha: 1).cgColor)
    ctx.fill(CGRect(x: 0, y: h * 0.45, width: w, height: h * 0.55))
    ctx.setFillColor(NSColor(calibratedRed: 0.78, green: 0.70, blue: 0.60, alpha: 1).cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h * 0.45))
    // Perspective floor grid.
    ctx.setStrokeColor(NSColor(white: 0.45, alpha: 0.5).cgColor)
    ctx.setLineWidth(1)
    let vanish = CGPoint(x: w / 2, y: h * 0.45)
    for k in -6...6 {
        ctx.move(to: vanish)
        ctx.addLine(to: CGPoint(x: w / 2 + CGFloat(k) * 90, y: 0))
    }
    for k in 1...5 {
        let y = h * 0.45 * pow(0.62, CGFloat(k))
        ctx.move(to: CGPoint(x: 0, y: y))
        ctx.addLine(to: CGPoint(x: w, y: y))
    }
    ctx.strokePath()
    // A "pillar" that slides across the room so viewers can see frames updating.
    let t = CGFloat(i) / CGFloat(count)
    let px = w * (0.2 + 0.6 * (0.5 - 0.5 * cos(t * 2 * .pi)))
    ctx.setFillColor(NSColor(calibratedRed: 0.16, green: 0.55, blue: 0.58, alpha: 1).cgColor)
    ctx.fill(CGRect(x: px - 18, y: h * 0.22, width: 36, height: h * 0.5))
    ctx.setFillColor(NSColor(calibratedRed: 0.10, green: 0.40, blue: 0.43, alpha: 1).cgColor)
    ctx.fill(CGRect(x: px - 18, y: h * 0.22, width: 10, height: h * 0.5))
    // Unmissable label.
    ctx.setFillColor(NSColor(calibratedRed: 0.78, green: 0.25, blue: 0.22, alpha: 0.92).cgColor)
    ctx.fill(CGRect(x: 0, y: h - 46, width: w, height: 46))
    text(ctx, "SYNTHETIC TEST FRAME: not a camera", 14, h - 31, size: 20, color: .white)
    text(ctx, "RoomBridge preview test · frame \(i + 1)/\(count)", 14, 12, size: 13, color: NSColor(white: 0.15, alpha: 1), bold: false)

    guard let image = ctx.makeImage() else { fatalError("image") }
    let url = outDir.appendingPathComponent(String(format: "frame-%02d.jpg", i))
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { fatalError("dest") }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fatalError("write") }
}
print("wrote \(count) frames to \(outDir.path)")
