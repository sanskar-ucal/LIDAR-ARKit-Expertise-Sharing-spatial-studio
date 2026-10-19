import type { Lesson, SceneObject } from "../protocol";
import { lessonSteps } from "../state";

const PRESET_LABEL: Record<Lesson["preset"], string> = {
  scan: "Scanning",
  move: "Moving (G)",
  rotate: "Rotating (R)",
  scale: "Scaling (S)",
  place: "Placing a piece",
  custom: "Task",
};

export function LessonBanner({ lesson, objects, hostName }: { lesson: Lesson | null; objects: SceneObject[]; hostName: string }) {
  if (!lesson) return null;
  const step = lessonSteps(lesson, objects)[0];
  return (
    <div className={`caption ${lesson.state === "done" ? "success" : "progress"}`} role="status" aria-live="polite">
      <strong>
        {PRESET_LABEL[lesson.preset]}: {lesson.byName} asks {hostName}: “{lesson.text}”
      </strong>
      <span>
        {lesson.state === "done" ? `${hostName} says it’s done.` : lesson.demo ? `The phone can loop a “show me” ghost of this move.` : "Waiting for the novice."}
        {step?.shortcut && step.concept !== "add" && (
          <>
            {" "}
            In Blender: <span className="mono">{step.shortcut}</span>
          </>
        )}
      </span>
    </div>
  );
}
