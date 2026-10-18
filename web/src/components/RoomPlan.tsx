import { kindInfo } from "../catalog";
import { AXIS_INFO, type Guidance, type Quat, type SceneObject, type Vec3 } from "../protocol";

interface Props {
  objects: SceneObject[];
  guidance: Guidance | null;
  selected: string | null;
  onSelect(id: string | null): void;
}

/** Heading about the vertical (Y) axis, radians. */
export function yaw(q: Quat): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

const deg = (r: number) => (r * 180) / Math.PI;

function Footprint({ o, pos, rot, className, onClick }: { o: SceneObject; pos: Vec3; rot: Quat; className: string; onClick?(): void }) {
  const [w, , d] = o.dimensions;
  // Plan view: screen x = world x, screen y = world z (forward, -Z, is up on screen).
  const transform = `translate(${pos[0]} ${pos[2]}) rotate(${-deg(yaw(rot))})`;
  return (
    <g transform={transform} className={className} onClick={onClick}>
      {kindInfo(o.kind)?.round ? (
        <circle r={w / 2} fill={o.color} />
      ) : (
        <rect x={-w / 2} y={-Math.max(d, 0.03) / 2} width={w} height={Math.max(d, 0.03)} fill={o.color} />
      )}
    </g>
  );
}

export function RoomPlan({ objects, guidance, selected, onSelect }: Props) {
  const live = objects.filter((o) => !o.stale);
  const pts: [number, number][] = [[0, 0]];
  for (const o of live) pts.push([o.position[0], o.position[2]]);
  if (guidance) pts.push([guidance.target.position[0], guidance.target.position[2]]);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const pad = 1;
  let minX = Math.min(...xs) - pad;
  let maxX = Math.max(...xs) + pad;
  let minZ = Math.min(...zs) - pad;
  let maxZ = Math.max(...zs) + pad;
  const span = Math.max(4, maxX - minX, maxZ - minZ);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  minX = cx - span / 2;
  maxX = cx + span / 2;
  minZ = cz - span / 2;
  maxZ = cz + span / 2;

  const grid: number[] = [];
  for (let v = Math.ceil(minX); v <= maxX; v++) grid.push(v);
  const gridZ: number[] = [];
  for (let v = Math.ceil(minZ); v <= maxZ; v++) gridZ.push(v);

  const guided = guidance ? objects.find((o) => o.id === guidance.objectId) : undefined;
  const axis = guidance ? AXIS_INFO[guidance.axis] : null;
  const stroke = span / 250;

  return (
    <section className="card plan">
      <h2>Room plan (seen from above)</h2>
      <svg viewBox={`${minX} ${minZ} ${span} ${span}`} role="img" aria-label="Top-down plan of the design objects">
        <rect x={minX} y={minZ} width={span} height={span} className="plan-bg" onClick={() => onSelect(null)} />
        {grid.map((v) => (
          <line key={`x${v}`} x1={v} x2={v} y1={minZ} y2={maxZ} className="plan-grid" strokeWidth={stroke} />
        ))}
        {gridZ.map((v) => (
          <line key={`z${v}`} y1={v} y2={v} x1={minX} x2={maxX} className="plan-grid" strokeWidth={stroke} />
        ))}
        <g className="plan-origin">
          <circle r={span / 80} />
          <text y={span / 25} fontSize={span / 40} textAnchor="middle">
            phone start
          </text>
        </g>
        {guidance && guided && axis && guidance.axis !== "y" && (
          <line
            x1={guidance.start.position[0]}
            y1={guidance.start.position[2]}
            x2={guidance.target.position[0]}
            y2={guidance.target.position[2]}
            stroke={axis.css}
            strokeWidth={stroke * 3}
            strokeDasharray={`${stroke * 8} ${stroke * 5}`}
          />
        )}
        {live.map((o) => (
          <g key={o.id}>
            <Footprint
              o={o}
              pos={o.position}
              rot={o.rotation}
              className={`plan-obj ${selected === o.id ? "selected" : ""} ${guidance?.objectId === o.id && guidance.state === "active" ? "dim" : ""} ${o.proposal ? "proposed" : ""}`}
              onClick={() => onSelect(selected === o.id ? null : o.id)}
            />
            <text x={o.position[0]} y={o.position[2] - Math.max(0.2, o.dimensions[2] / 2 + 0.12)} fontSize={span / 38} textAnchor="middle" className="plan-label">
              {o.name}
            </text>
          </g>
        ))}
        {guidance && guided && (
          <>
            <Footprint o={guided} pos={guidance.target.position} rot={guidance.target.rotation} className="plan-ghost" />
            {guidance.attempt && guidance.state === "active" && (
              <circle cx={guidance.attempt.position[0]} cy={guidance.attempt.position[2]} r={span / 70} className="plan-attempt" />
            )}
          </>
        )}
      </svg>
      <p className="fine">
        Grid squares are 1 m. Dashed outline = target; orange dot = where the phone user has moved it; faded = the novice’s proposal.
        {guidance?.axis === "y" && " This move is up/down, so it does not show on the plan."}
      </p>
    </section>
  );
}
