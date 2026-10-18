import { AXIS_INFO, type Guidance, type SceneObject } from "./protocol";

export interface Caption {
  tone: "info" | "progress" | "success";
  title: string;
  detail: string;
}

export function formatMeters(m: number): string {
  const a = Math.abs(m);
  return a < 1 ? `${Math.round(a * 100)} cm` : `${a.toFixed(2)} m`;
}

/** Plain-language narration of the guidance step for observers. */
export function guidanceCaption(g: Guidance | null, objects: SceneObject[]): Caption | null {
  if (!g) return null;
  const obj = objects.find((o) => o.id === g.objectId);
  const name = obj ? `“${obj.name}”` : "the object";
  const axis = AXIS_INFO[g.axis];
  const start = g.start.position;
  const target = g.target.position;
  const total = Math.hypot(target[0] - start[0], target[1] - start[1], target[2] - start[2]);
  switch (g.state) {
    case "preview":
      return {
        tone: "info",
        title: `The expert is proposing a new spot for ${name}`,
        detail: `The see-through copy is the target, ${formatMeters(total)} along the ${axis.color} (${axis.direction}) axis.`,
      };
    case "active": {
      const a = g.attempt;
      const distance = a ? a.distance : total;
      if (a?.withinTolerance) {
        return { tone: "success", title: `${name} is on target`, detail: "Waiting for the expert to approve the new position." };
      }
      return {
        tone: "progress",
        title: `Move along the ${axis.color} (${axis.direction}) axis toward the target, ${formatMeters(distance)}`,
        detail: a?.holding ? "The phone user is moving it now." : "The phone user holds a button and walks the phone along the line.",
      };
    }
    case "approved":
      return { tone: "success", title: `Approved: ${name} is in its new place`, detail: "The expert confirmed the move." };
  }
}
