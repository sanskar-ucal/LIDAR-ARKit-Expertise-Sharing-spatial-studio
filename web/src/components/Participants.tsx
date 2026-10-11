import { ROLE_LABEL, type Participant, type SceneObject } from "../protocol";

interface Props {
  participants: Participant[];
  me: string | null;
  objects: SceneObject[];
}

export function Participants({ participants, me, objects }: Props) {
  const order = { host: 0, expert: 1, viewer: 2 } as const;
  const sorted = [...participants].sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName));
  return (
    <section className="card">
      <h2>Who’s here</h2>
      <ul className="people">
        {sorted.map((p) => {
          const looking = p.selectedObjectId ? objects.find((o) => o.id === p.selectedObjectId)?.name : null;
          return (
            <li key={p.clientId} className={p.connected ? "" : "offline"}>
              <span className={`dot ${p.connected ? "on" : ""}`} aria-hidden />
              <span className="name">
                {p.displayName}
                {p.clientId === me && <span className="muted"> (you)</span>}
              </span>
              <span className={`tag role-${p.role}`}>{ROLE_LABEL[p.role]}</span>
              {looking && <span className="muted small">looking at {looking}</span>}
              {!p.connected && <span className="muted small">reconnecting…</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
