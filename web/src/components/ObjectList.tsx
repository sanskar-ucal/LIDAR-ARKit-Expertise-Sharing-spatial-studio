import { kindInfo, kindLabel } from "../catalog";
import type { Comment, Reactions, SceneObject } from "../protocol";

interface Props {
  objects: SceneObject[];
  reactions: Record<string, Reactions>;
  comments: Comment[];
  me: string | null;
  selected: string | null;
  guidedId: string | null;
  onSelect(id: string | null): void;
  onReact(objectId: string, kind: "like" | "discuss"): void;
}

export function describeSize(o: SceneObject): string {
  const [w, h, d] = o.dimensions.map((v) => v.toFixed(2));
  return kindInfo(o.kind)?.round ? `Ø ${w} m, ${h} m tall` : `${w} × ${h} × ${d} m`;
}

export function ObjectList({ objects, reactions, comments, me, selected, guidedId, onSelect, onReact }: Props) {
  return (
    <section className="card">
      <h2>Design objects</h2>
      {objects.length === 0 && <p className="muted">No objects yet. The expert adds them from Blender; the novice can propose them from the phone.</p>}
      <ul className="objects">
        {objects.map((o) => {
          const r = reactions[o.id] ?? { like: [], discuss: [] };
          const count = comments.filter((c) => c.objectId === o.id).length;
          const isSel = selected === o.id;
          return (
            <li key={o.id} className={isSel ? "selected" : ""}>
              <button className="object-main" onClick={() => onSelect(isSel ? null : o.id)} aria-pressed={isSel}>
                <span className="swatch" style={{ background: o.color }} aria-hidden />
                <span>
                  <strong>{o.name}</strong>
                  <span className="muted small">
                    {" "}
                    {o.name.toLowerCase().startsWith(kindLabel(o.kind).toLowerCase()) ? "" : `${kindLabel(o.kind)} · `}
                    {describeSize(o)}
                  </span>
                  {o.stale && <span className="tag warn">needs re-placing</span>}
                  {o.proposal && <span className="tag proposal">proposed by {o.proposal.byName} · awaiting expert</span>}
                  {guidedId === o.id && <span className="tag accent">being moved</span>}
                </span>
              </button>
              <div className="reactions">
                <button
                  className={me && r.like.includes(me) ? "react on" : "react"}
                  onClick={() => onReact(o.id, "like")}
                  aria-label={`Like ${o.name}`}
                >
                  ♥ {r.like.length}
                </button>
                <button
                  className={me && r.discuss.includes(me) ? "react on" : "react"}
                  onClick={() => onReact(o.id, "discuss")}
                  aria-label={`Let's discuss ${o.name}`}
                >
                  ? {r.discuss.length}
                </button>
                <span className="muted small">{count} 💬</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
