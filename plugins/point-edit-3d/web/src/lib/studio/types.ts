export type Tool = "look" | "pick" | "box" | "volume" | "frame";
export type SelectionVolume = { kind: 'axis_aligned_box'; coordinateSystem: 'gltf_y_up' | 'web_scene_y_up'; min: [number,number,number]; max: [number,number,number] };
export type SelectionRegion = { id:string; volume:SelectionVolume; objectIds:string[]; visible:boolean };
export type Intent = "question" | "edit";
export type Finish = "ceramic" | "brass" | "matte" | "oak" | "restore";

export type TargetRef = {
  objectId: string;
  name: string;
  coverage: number | null;
  /** false：框选擦到的后景，不进入这条批注的修改范围。缺省视为纳入。 */
  included?: boolean;
  sceneUid?: string | null;
  point?: [number, number, number];
  instanceId?: number;
  instanceHits?: {meshPath:string; instanceId:number}[];
  samples?: { screen: [number, number]; depth: number; point: [number, number, number]; instanceId?: number }[];
  totalSamples?: number;
  role?: "object" | "surface";
  depth?: number;
  depthMin?: number;
  depthMax?: number;
  score?: number;
  frontDepth?: number;
  frontThickness?: number;
  rays?: RaySample[];
};

export type RaySample = { screen: [number, number]; objectId: string | null; depth: number | null; point: [number, number, number] | null; instanceId?: number };

export type Annotation = {
  id: string;
  number: number;
  intent: Intent;
  text: string;
  scope: "objects" | "viewport";
  targets: TargetRef[];
  reply: string | null;
  createdAt: number;
  sceneUid?: string | null;
  identity?: "blender_uid" | "web_scene" | "c4d_object" | "snapshot_only";
  sourceRevision?: string | null;
  selectionVolume?: SelectionVolume | null;
  selectionVolumes?: SelectionRegion[];
  pointSelectionIds?: string[];
  hiddenPointIds?: string[];
  highlightVisible?: boolean;
};

export type PickHit = {
  objectId: string;
  name: string;
  materialName: string;
  point: [number, number, number];
  instanceId?: number;
  instanceHits?: {meshPath:string; instanceId:number}[];
  coverage: number | null;
  samples?: TargetRef["samples"];
  totalSamples?: number;
  role?: TargetRef["role"];
  depth?: number;
  depthMin?: number;
  depthMax?: number;
  score?: number;
  frontDepth?: number;
  frontThickness?: number;
  rays?: RaySample[];
};

export type ViewportHandle = {
  resetVolume: () => void;
  cancelVolume: () => void;
  confirmVolume: () => void;
  nudge: (id: string, axis: "x" | "y" | "z", delta: number) => void;
  scaleBy: (id: string, factor: number) => void;
  finish: (id: string, preset: Finish) => void;
  undo: () => boolean;
};
