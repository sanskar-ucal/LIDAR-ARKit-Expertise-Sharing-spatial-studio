import RealityKit
import RoomBridgeCore
import UIKit

/// World-anchored rendering of the synchronised scene plus the guidance layer.
/// Everything is parented to one AnchorEntity at the AR session origin, so object
/// poses are canonical room coordinates with no further conversion.
@MainActor
final class SceneRenderer {
    struct ObjectDecor: Equatable {
        var selectedBy: [String] = []
        var commentCount = 0
        var role: Role? = nil
        /// The novice's own proposal, waiting for the expert.
        var mineProposal = false
        var editing = false
    }

    private let root = AnchorEntity(world: .zero)
    private var objects: [String: ObjectNode] = [:]
    private var target: ObjectNode?
    private var attempt: ObjectNode?
    private var placement: ObjectNode?
    private var axisLine: Entity?
    private var axisKey = ""
    private var distanceLabel: Entity?
    private var distanceText = ""

    init(arView: ARView) {
        arView.scene.addAnchor(root)
    }

    // MARK: Design objects

    func sync(objects list: [SceneObject], decor: [String: ObjectDecor], guidance: Guidance?) {
        let live = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        for (id, node) in objects where live[id] == nil {
            node.entity.removeFromParent()
            objects[id] = nil
        }
        for obj in list {
            let node = objects[obj.id] ?? {
                let n = ObjectNode(style: .proposal)
                root.addChild(n.entity)
                objects[obj.id] = n
                return n
            }()
            let dimmed = guidance?.objectId == obj.id && guidance?.state == .active
            node.update(object: obj, label: label(for: obj, decor: decor[obj.id] ?? ObjectDecor(), guidance: guidance), dimmed: dimmed,
                        pending: obj.proposal != nil)
            // Objects from a previous AR origin are not drawn: their coordinates are meaningless now.
            node.entity.isEnabled = !obj.stale
        }
        syncGuidance(guidance, objects: live)
    }

    private func label(for o: SceneObject, decor: ObjectDecor, guidance: Guidance?) -> String {
        var lines = [o.name]
        let d = o.dimensions
        if AppCatalog.kind(o.kind).round {
            lines.append(String(format: "Ø %.2f m × %.2f m tall", d.x, d.y))
        } else {
            lines.append(String(format: "%.2f × %.2f × %.2f m", d.x, d.y, d.z))
        }
        if let p = o.proposal {
            lines.insert(decor.mineProposal ? (decor.editing ? "YOUR PROPOSAL · editing" : "YOUR PROPOSAL · waiting for the expert")
                                            : "PROPOSED BY \(p.byName.uppercased())", at: 0)
        }
        if let g = guidance, g.objectId == o.id {
            switch g.state {
            case .active: lines.insert("EXPERT'S PROPOSAL", at: 0)
            case .approved: lines.insert("APPROVED BY EXPERT", at: 0)
            case .preview: break
            }
        }
        if decor.commentCount > 0 { lines.append("\(decor.commentCount) comment\(decor.commentCount == 1 ? "" : "s")") }
        if !decor.selectedBy.isEmpty { lines.append("Looking: " + decor.selectedBy.joined(separator: ", ")) }
        return lines.joined(separator: "\n")
    }

    // MARK: "Show me" demo

    private var demo: ObjectNode?

    /// The expert's demonstration: a translucent ghost of the object, animated by the caller.
    func showDemo(_ o: SceneObject?, label: String) {
        guard let o else {
            demo?.entity.removeFromParent()
            demo = nil
            return
        }
        let node = demo ?? {
            let n = ObjectNode(style: .target)
            root.addChild(n.entity)
            demo = n
            return n
        }()
        node.update(object: o, label: label, dimmed: false)
    }

    // MARK: Placement preview

    /// Translucent preview of the object the novice is about to propose, at the crosshair.
    func showPlacement(_ o: SceneObject?, label: String) {
        guard let o else {
            placement?.entity.removeFromParent()
            placement = nil
            return
        }
        let node = placement ?? {
            let n = ObjectNode(style: .placement)
            root.addChild(n.entity)
            placement = n
            return n
        }()
        node.update(object: o, label: label, dimmed: false)
    }

    // MARK: Guidance layer

    private func syncGuidance(_ g: Guidance?, objects live: [String: SceneObject]) {
        // After approval the object itself sits in its new place; the ghost would only add clutter.
        guard let g, g.state != .approved, let obj = live[g.objectId], !obj.stale else {
            target?.entity.removeFromParent(); target = nil
            attempt?.entity.removeFromParent(); attempt = nil
            axisLine?.removeFromParent(); axisLine = nil; axisKey = ""
            distanceLabel?.removeFromParent(); distanceLabel = nil; distanceText = ""
            return
        }
        // Ghost target: translucent, labelled.
        let t = target ?? {
            let n = ObjectNode(style: .target)
            root.addChild(n.entity)
            target = n
            return n
        }()
        var ghost = obj
        ghost.position = g.target.position
        ghost.rotation = g.target.rotation
        t.update(object: ghost, label: "TARGET\nplace it here", dimmed: false)

        // Axis guide through the start pose.
        let key = "\(g.id)|\(g.axis.rawValue)|\(g.start.position)|\(g.target.position)"
        if key != axisKey {
            axisLine?.removeFromParent()
            let line = Self.axisEntity(g)
            root.addChild(line)
            axisLine = line
            axisKey = key
        }

        if g.state == .active {
            if attempt == nil {
                let n = ObjectNode(style: .attempt)
                root.addChild(n.entity)
                attempt = n
            }
        } else {
            attempt?.entity.removeFromParent()
            attempt = nil
        }
    }

    /// Called every AR frame while guidance is active, with the phone's local attempt offset
    /// (immediate feedback, independent of network round trips).
    func updateAttempt(guidance g: Guidance?, object: SceneObject?, offset: Double, holding: Bool) {
        guard let g, let object, let attempt, g.state == .active else {
            distanceLabel?.removeFromParent(); distanceLabel = nil; distanceText = ""
            return
        }
        var a = object
        a.position = GuidanceMath.attemptPosition(g, offset: offset)
        a.rotation = g.start.rotation
        attempt.update(object: a, label: holding ? "YOUR ATTEMPT\nmoving" : "YOUR ATTEMPT", dimmed: false)

        let distance = GuidanceMath.distanceToTarget(g, offset: offset)
        let text = distance <= g.tolerance ? "On target ✓" : String(format: "%.0f cm to go", distance * 100)
        if text != distanceText {
            distanceText = text
            distanceLabel?.removeFromParent()
            let l = Self.textEntity(text, size: 0.06, color: distance <= g.tolerance ? UIColor(red: 0.24, green: 0.61, blue: 0.37, alpha: 1) : .white)
            root.addChild(l)
            distanceLabel = l
        }
        let top = Float(AppCatalog.kind(object.kind).top(object.dimensions))
        distanceLabel?.position = SIMD3<Float>(a.position) + SIMD3<Float>(0, top + 0.45, 0)
    }

    private static func axisEntity(_ g: Guidance) -> Entity {
        let container = Entity()
        let color: UIColor
        switch g.axis {
        case .x: color = UIColor(red: 0.86, green: 0.25, blue: 0.24, alpha: 1)
        case .y: color = UIColor(red: 0.23, green: 0.43, blue: 0.80, alpha: 1)
        case .z: color = UIColor(red: 0.35, green: 0.68, blue: 0.29, alpha: 1)
        }
        let material = UnlitMaterial(color: color)
        let dir = SIMD3<Float>(g.axis.unit)
        let start = SIMD3<Float>(g.start.position)
        let targetOffset = Float(g.targetOffset)
        let span = max(abs(targetOffset) + 0.6, 1.2)
        let thickness: Float = 0.008
        let size = SIMD3<Float>(dir.x != 0 ? span : thickness, dir.y != 0 ? span : thickness, dir.z != 0 ? span : thickness)
        let line = ModelEntity(mesh: .generateBox(size: size), materials: [material])
        // Lift horizontal guides slightly so they are not hidden in the floor.
        let lift: SIMD3<Float> = g.axis == .y ? .zero : SIMD3<Float>(0, 0.02, 0)
        line.position = start + dir * (targetOffset / 2) + lift
        container.addChild(line)
        let sign: Float = targetOffset >= 0 ? 1 : -1
        let cone = ModelEntity(mesh: .generateCone(height: 0.08, radius: 0.03), materials: [material])
        cone.orientation = simd_quatf(from: SIMD3<Float>(0, 1, 0), to: dir * sign)
        cone.position = start + dir * (targetOffset + sign * 0.06) + lift
        container.addChild(cone)
        let caption = textEntity("Move along the \(g.axis.colorName.uppercased()) line (\(g.axis.directionName))", size: 0.035, color: .white)
        caption.position = start + dir * (targetOffset / 2) + lift + SIMD3<Float>(0, 0.12, 0)
        container.addChild(caption)
        return container
    }

    // MARK: Text

    static func textEntity(_ text: String, size: CGFloat, color: UIColor) -> Entity {
        let mesh = MeshResource.generateText(
            text, extrusionDepth: 0.001, font: .systemFont(ofSize: size, weight: .semibold),
            containerFrame: .zero, alignment: .center, lineBreakMode: .byWordWrapping)
        let textModel = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: color)])
        let b = mesh.bounds
        textModel.position = SIMD3<Float>(-b.center.x, -b.center.y, 0.002)
        var plate = UnlitMaterial(color: UIColor(white: 0.1, alpha: 1))
        plate.blending = .transparent(opacity: .init(floatLiteral: 0.55))
        let back = ModelEntity(mesh: .generatePlane(width: b.extents.x + 0.04, height: b.extents.y + 0.03), materials: [plate])
        let holder = Entity()
        holder.addChild(back)
        holder.addChild(textModel)
        holder.components.set(BillboardComponent())
        return holder
    }
}

/// One rendered primitive with its label. Mesh is rebuilt only when kind/size/look change.
@MainActor
final class ObjectNode {
    /// `.proposal` is a normal design object ("the expert's proposal" for the room).
    enum Style { case proposal, target, attempt, placement }

    let entity = Entity()
    private let style: Style
    private var modelKey = ""
    private var labelText = ""
    private var model: Entity?
    private var label: Entity?

    init(style: Style) {
        self.style = style
    }

    func update(object o: SceneObject, label text: String, dimmed: Bool, pending: Bool = false) {
        entity.position = SIMD3<Float>(o.position)
        entity.orientation = Coordinates.simdQuatf(o.rotation)
        let key = "\(o.kind)|\(o.dimensions)|\(o.color)|\(o.textureRef ?? "")|\(dimmed)|\(pending)"
        if key != modelKey {
            model?.removeFromParent()
            let m = Self.makeModel(o, style: style, opacity: dimmed ? 0.35 : (pending ? 0.7 : 1))
            entity.addChild(m)
            model = m
            modelKey = key
        }
        if text != labelText {
            label?.removeFromParent()
            let color: UIColor
            switch style {
            case .proposal, .placement: color = .white
            case .target: color = UIColor(red: 0.55, green: 0.9, blue: 0.92, alpha: 1)
            case .attempt: color = UIColor(red: 1, green: 0.78, blue: 0.5, alpha: 1)
            }
            let l = SceneRenderer.textEntity(text, size: 0.04, color: color)
            entity.addChild(l)
            label = l
            labelText = text
        }
        let top = Float(AppCatalog.kind(o.kind).top(o.dimensions))
        // Attempt labels sit lower so they do not overlap the target label at the goal.
        label?.position = SIMD3<Float>(0, top + (style == .attempt ? 0.08 : 0.2), 0)
    }

    private static func material(hex: String, style: Style, opacity: Float) -> RealityKit.Material {
        switch style {
        case .target:
            var m = UnlitMaterial(color: UIColor(red: 0.18, green: 0.64, blue: 0.66, alpha: 1))
            m.blending = .transparent(opacity: .init(floatLiteral: 0.35))
            return m
        case .attempt:
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: UIColor(red: 0.91, green: 0.54, blue: 0.17, alpha: 1))
            m.blending = .transparent(opacity: .init(floatLiteral: 0.8))
            return m
        case .placement:
            var m = UnlitMaterial(color: UIColor(hex: hex) ?? .white)
            m.blending = .transparent(opacity: .init(floatLiteral: 0.5))
            return m
        case .proposal:
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: UIColor(hex: hex) ?? .lightGray)
            m.roughness = 0.7
            if opacity < 1 { m.blending = .transparent(opacity: .init(floatLiteral: opacity)) }
            return m
        }
    }

    private static let unitBox = MeshResource.generateBox(size: 1)
    private static let unitCylinder = MeshResource.generateCylinder(height: 1, radius: 0.5)
    private static let unitSphere = MeshResource.generateSphere(radius: 0.5)

    /// Catalog kinds: each part is a unit box/cylinder/sphere scaled into the object's size.
    private static func partsModel(_ o: SceneObject, style: Style, opacity: Float) -> Entity {
        let d = SIMD3<Float>(o.dimensions)
        let group = Entity()
        for part in AppCatalog.kind(o.kind).parts {
            let mesh: MeshResource
            switch part.shape {
            case .box: mesh = unitBox
            case .cylinder: mesh = unitCylinder
            case .sphere: mesh = unitSphere
            }
            let mat = material(hex: Catalog.tintHex(part.tint, base: o.color), style: style, opacity: opacity)
            let e = ModelEntity(mesh: mesh, materials: [mat])
            e.scale = SIMD3<Float>(part.size) * d
            e.position = SIMD3<Float>(part.center) * d
            group.addChild(e)
        }
        return group
    }

    static func makeModel(_ o: SceneObject, style: Style, opacity: Float) -> Entity {
        let d = SIMD3<Float>(o.dimensions)
        let mat = material(hex: o.color, style: style, opacity: opacity)
        switch o.kind {
        case .pillar:
            let m = ModelEntity(mesh: .generateCylinder(height: d.y, radius: d.x / 2), materials: [mat])
            m.position.y = d.y / 2  // origin at base centre
            return m
        case .partition:
            let m = ModelEntity(mesh: .generateBox(size: d), materials: [mat])
            m.position.y = d.y / 2  // origin at bottom centre
            return m
        case .panel:
            let group = Entity()  // origin at centre; picture faces local +Z
            group.addChild(ModelEntity(mesh: .generateBox(size: d), materials: [mat]))
            if style == .proposal, o.textureRef == "sample:picture", let pic = PictureTexture.material() {
                let face = ModelEntity(mesh: .generatePlane(width: d.x * 0.92, height: d.y * 0.92), materials: [pic])
                face.position.z = d.z / 2 + 0.001
                group.addChild(face)
            }
            return group
        default:
            return partsModel(o, style: style, opacity: opacity)
        }
    }
}

/// The same procedural landscape as the Blender add-on (sun top-right so a flipped or
/// rotated picture is obvious).
@MainActor
enum PictureTexture {
    private static var cached: UnlitMaterial?

    static func material() -> UnlitMaterial? {
        if let cached { return cached }
        let size = CGSize(width: 512, height: 384)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let img = UIGraphicsImageRenderer(size: size, format: fmt).image { ctx in
            let c = ctx.cgContext
            let colors = [UIColor(red: 0.6, green: 0.6, blue: 0.9, alpha: 1).cgColor, UIColor(red: 0.95, green: 0.75, blue: 0.55, alpha: 1).cgColor]
            if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1]) {
                c.drawLinearGradient(grad, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            }
            UIColor(red: 1, green: 0.85, blue: 0.35, alpha: 1).setFill()
            c.fillEllipse(in: CGRect(x: size.width * 0.78 - 35, y: size.height * 0.25 - 35, width: 70, height: 70))
            let hills = UIBezierPath()
            hills.move(to: CGPoint(x: 0, y: size.height))
            for x in stride(from: 0, through: size.width, by: 4) {
                let fx = x / size.width
                let h = 0.28 + 0.08 * sin(fx * 6.2) + 0.04 * sin(fx * 17)
                hills.addLine(to: CGPoint(x: x, y: size.height * (1 - h)))
            }
            hills.addLine(to: CGPoint(x: size.width, y: size.height))
            hills.close()
            UIColor(red: 0.25, green: 0.5, blue: 0.32, alpha: 1).setFill()
            hills.fill()
        }
        guard let cg = img.cgImage, let tex = try? TextureResource.generate(from: cg, options: .init(semantic: .color)) else { return nil }
        var m = UnlitMaterial()
        m.color = .init(tint: .white, texture: .init(tex))
        cached = m
        return m
    }
}

extension UIColor {
    convenience init?(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}
