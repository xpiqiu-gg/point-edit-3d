import { create } from "zustand";
import type { Annotation, Intent, PickHit, TargetRef, Tool, SelectionVolume, SelectionRegion } from "@/lib/studio/types";
import { isC4d, sourceInfo, sessionId } from '@/lib/studio/source';
import { referenceNumbers, renumberAnnotations } from '@/lib/studio/annotation-numbers';

const STORAGE_KEY = `point-edit-3d-session-${sessionId}`;
const CLIENT_KEY = `${STORAGE_KEY}-bridge-client`;
const SEQUENCE_KEY = `${STORAGE_KEY}-bridge-sequence`;

let bridgeQueue = Promise.resolve();
let latestSequence = 0;

/**
 * 身份标签决定批注能否回投到源场景：只有所有目标都带当前场景的稳定编号才算稳定。
 * c4d_object C4D 物体编号；blender_uid Blender 物体 UID；
 * snapshot_only 旧快照或无法对应，只能参考。
 */
function draftIdentity(scope: "objects" | "viewport", selection: TargetRef[], sceneUid: string | null): Annotation["identity"] {
  if (scope === "viewport") return "snapshot_only";
  if (!sceneUid || selection.length === 0) return "snapshot_only";
  const stable = selection.every((item) => /^[a-f0-9]{32}$/.test(item.objectId) && item.sceneUid === sceneUid);
  if (!stable) return "snapshot_only";
  return isC4d ? "c4d_object" : "blender_uid";
}

type Persisted = {
  annotations: Annotation[];
  revision: number;
  nextNumber?: number;
};

type StudioState = {
  tool: Tool;
  scope: "objects" | "viewport";
  selection: TargetRef[];
  selectionVolume: SelectionVolume | null;
  selectionVolumes: SelectionRegion[];
  pointSelectionIds: string[];
  hiddenPointIds: string[];
  hit: PickHit | null;
  draftIntent: Intent;
  draftText: string;
  annotations: Annotation[];
  revision: number;
  hydrated: boolean;
  nextNumber: number;
  sceneUid: string | null;
  setSceneUid: (uid: string | null) => void;
  bridgeStatus: "idle" | "sending" | "sent" | "error";
  retryBridge: () => void;
  setTool: (tool: Tool) => void;
  setSelection: (targets: TargetRef[], hit: PickHit | null, volume?: SelectionVolume | null) => void;
  clearSelection: () => void;
  armViewport: () => void;
  setDraftIntent: (intent: Intent) => void;
  setDraftText: (text: string) => void;
  saveDraft: () => boolean;
  removeAnnotation: (id: string) => void;
  editAnnotation: (id: string, text: string, targets?: TargetRef[], volume?: SelectionVolume | null, regions?: SelectionRegion[], points?:string[], hidden?:string[]) => boolean;
  setAnnotationIntent: (id: string, intent: Intent) => void;
  setAnnotationHighlight: (id: string, visible: boolean) => void;
  setAllAnnotationHighlights: (visible: boolean) => void;
  focusAnnotation: (id: string) => void;
  markMutation: () => void;
  hydrate: () => void;
};

function loadPersisted(): Persisted | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Persisted;
    if (!Array.isArray(parsed.annotations)) return null;
    let next = 1;
    const annotations = [...parsed.annotations].reverse().map((note) => {
      const number = note.scope === "viewport" ? 0 : (typeof note.number === "number" && note.number > 0 ? note.number : next);
      if (number > 0) next = Math.max(next, number + 1);
      return { ...note, number };
    }).reverse();
    const normalized = renumberAnnotations(annotations, annotations);
    return { annotations: normalized.annotations, revision: parsed.revision || 1, nextNumber: normalized.nextNumber };
  } catch {
    return null;
  }
}

function savePersisted(annotations: Annotation[], revision: number, nextNumber: number) {
  if (typeof localStorage === "undefined") return;
  const payload: Persisted = { annotations, revision, nextNumber };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  sendToBridge(payload);
}

function sendToBridge(payload: Persisted) {
  let clientId = sessionStorage.getItem(CLIENT_KEY);
  if (!clientId) { clientId = crypto.randomUUID(); sessionStorage.setItem(CLIENT_KEY, clientId); }
  const sequence = Number(sessionStorage.getItem(SEQUENCE_KEY) || 0) + 1;
  sessionStorage.setItem(SEQUENCE_KEY, String(sequence));
  latestSequence = sequence;
  useStudio.setState({ bridgeStatus: 'sending' });
  const annotations = payload.annotations.map(note => ({...note, references: referenceNumbers(note.text).map(number => {
    const target = payload.annotations.find(item => item.number === number);
    return target ? {number, id: target.id} : {number, missing: true};
  })}));
  const body = JSON.stringify({app:'point-edit-3d', schemaVersion:1, sessionId, source:sourceInfo, scene:sourceInfo.name, file:sourceInfo.file, clientId, sequence, revision:payload.revision, annotations});
  bridgeQueue = bridgeQueue.catch(() => {}).then(async () => {
    try {
      const response = await fetch('/__point_edit_3d/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body});
      if (!response.ok || !(await response.json()).ok) throw new Error('提交失败');
      if (sequence === latestSequence) useStudio.setState({bridgeStatus:'sent'});
    } catch {
      if (sequence === latestSequence) useStudio.setState({bridgeStatus:'error'});
    }
  });
}

export const useStudio = create<StudioState>((set, get) => ({
  tool: "pick",
  scope: "objects",
  selection: [],
  selectionVolume: null,
  selectionVolumes: [],
  pointSelectionIds: [],
  hiddenPointIds: [],
  hit: null,
  draftIntent: "question",
  draftText: "",
  annotations: [],
  revision: 1,
  hydrated: false,
  nextNumber: 1,
  sceneUid: null,
  setSceneUid: (sceneUid) => set({sceneUid}),
  bridgeStatus: "idle",
  retryBridge: () => sendToBridge({annotations:get().annotations, revision:get().revision, nextNumber:get().nextNumber}),
  setTool: (tool) =>
    set({
      tool,
      scope: tool === "frame" ? "viewport" : "objects",
      selection: get().selection,
      selectionVolume: get().selectionVolume,
      hit: tool === "frame" ? null : get().hit,
    }),
  setSelection: (targets, hit, volume = null) => set({ selection: targets, hit, scope: "objects", selectionVolume: volume }),
  clearSelection: () => set({ selection: [], hit: null, scope: "objects", selectionVolume: null, selectionVolumes:[],pointSelectionIds:[],hiddenPointIds:[] }),
  armViewport: () => set({ scope: "viewport", hit: null, tool: "frame" }),
  setDraftIntent: (draftIntent) => set({ draftIntent }),
  setDraftText: (draftText) => set({ draftText }),
  saveDraft: () => {
    const { draftText, draftIntent, selection, scope, annotations } = get();
    const text = draftText;
    const bound = selection.filter((item) => item.included !== false);
    if (!text.trim()) return false;
    if (scope !== "viewport" && bound.length === 0) return false;
    const note: Annotation = {
      id: crypto.randomUUID(),
      number: scope === "viewport" ? 0 : get().nextNumber,
      intent: draftIntent,
      text,
      scope,
      targets: scope === "viewport" ? [] : selection.map((item) => ({ ...item, included: item.included !== false })),
      selectionVolume: scope === 'objects' ? get().selectionVolume : null,
      selectionVolumes: scope === 'objects' ? get().selectionVolumes.map(r=>({...r,objectIds:[...r.objectIds]})) : [],
      pointSelectionIds: scope === 'objects' ? [...get().pointSelectionIds] : [],
      hiddenPointIds: scope === 'objects' ? [...get().hiddenPointIds] : [],
      reply: null,
      createdAt: Date.now(),
      sceneUid: get().sceneUid,
      sourceRevision: null,
      identity: draftIdentity(scope, selection, get().sceneUid),
    };
    const next = [note, ...annotations];
    const nextNumber = note.number === 0 ? get().nextNumber : get().nextNumber + 1;
    set({ annotations: next, draftText: "", nextNumber, selection: [], selectionVolume: null, selectionVolumes: [], pointSelectionIds: [], hiddenPointIds: [], hit: null, scope: "objects", tool: get().tool === "frame" ? "pick" : get().tool });
    savePersisted(next, get().revision, nextNumber);
    return true;
  },
  removeAnnotation: (id) => {
    const previous = get().annotations;
    if (!previous.some(item => item.id === id)) return;
    const next = renumberAnnotations(previous.filter(item => item.id !== id), previous);
    set({ annotations: next.annotations, nextNumber: next.nextNumber });
    savePersisted(next.annotations, get().revision, next.nextNumber);
  },
  editAnnotation: (id, text, targets, volume = null, regions = [], points = [], hidden = []) => {
    if (!text.trim()) return false;
    const {annotations} = get();
    const note = annotations.find(item => item.id === id);
    if (!note) return false;
    if (targets && (note.scope !== 'objects' || !note.sceneUid || !targets.some(item => item.included !== false) || targets.some(item => item.sceneUid !== note.sceneUid))) return false;
    const next = annotations.map(item => item.id === id ? {...item, text, ...(targets ? {targets:targets.map(target=>({...target})), selectionVolume:volume,selectionVolumes:regions,pointSelectionIds:points,hiddenPointIds:hidden} : {})} : item);
    set({annotations:next});
    savePersisted(next, get().revision, get().nextNumber);
    return true;
  },
  setAnnotationIntent: (id, intent) => {
    const next = get().annotations.map((item) => (item.id === id ? { ...item, intent } : item));
    set({ annotations: next });
    savePersisted(next, get().revision, get().nextNumber);
  },
  setAnnotationHighlight: (id, visible) => {
    const annotations = get().annotations.map(note => note.id === id ? {...note, highlightVisible: visible} : note);
    set({annotations});
    savePersisted(annotations, get().revision, get().nextNumber);
  },
  setAllAnnotationHighlights: (visible) => {
    const annotations = get().annotations.map(note => ({...note, highlightVisible: visible}));
    set({annotations});
    savePersisted(annotations, get().revision, get().nextNumber);
  },
  focusAnnotation: (id) => {
    const note = get().annotations.find((item) => item.id === id);
    if (!note) return;
    if (note.scope === "viewport") {
      set({ scope: "viewport", hit: null, tool: "frame" });
      return;
    }
    set({
      scope: "objects",
      selection: note.targets.map((item) => ({ ...item })),
      selectionVolume: note.selectionVolume ?? null,
      selectionVolumes: note.selectionVolumes?.map(region => ({...region, visible:true})) ?? (note.selectionVolume ? [{id:'legacy-'+note.id,volume:note.selectionVolume,objectIds:note.targets.map(t=>t.objectId),visible:true}] : []),
      pointSelectionIds: note.pointSelectionIds ?? (note.selectionVolume ? [] : note.targets.filter(t=>t.coverage==null && t.role!=='surface').map(t=>t.objectId)),
      hiddenPointIds: [],
      tool: "pick",
      hit: null,
    });
  },
  markMutation: () => {
    const revision = get().revision + 1;
    set({ revision });
    savePersisted(get().annotations, revision, get().nextNumber);
  },
  hydrate: () => {
    if (get().hydrated) return;
    const saved = loadPersisted();
    if (saved) { set({ annotations: saved.annotations, revision: saved.revision, nextNumber: saved.nextNumber || 1, hydrated: true }); localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); if (saved.annotations.length) sendToBridge(saved); }
    else set({ hydrated: true });
  },
}));

