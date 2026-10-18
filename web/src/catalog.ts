// The shared object catalog (protocol/catalog.json), bundled into the viewer at build time.
import data from "../../protocol/catalog.json";

export interface CatalogKind {
  kind: string;
  label: string;
  group: string;
  origin: "bottom" | "center";
  mount: "floor" | "wall";
  height: number;
  dimensions: [number, number, number];
  color: string;
  round: boolean;
  lesson: string;
  blender: string;
}

export const CATALOG = data.kinds as unknown as CatalogKind[];
const BY_KIND = new Map(CATALOG.map((k) => [k.kind, k]));

export function kindInfo(kind: string): CatalogKind | undefined {
  return BY_KIND.get(kind);
}

export function kindLabel(kind: string): string {
  return BY_KIND.get(kind)?.label ?? kind;
}
