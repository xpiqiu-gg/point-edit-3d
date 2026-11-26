import { useEffect, useMemo, useRef, useState, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AppWindow,
  Box,
  Download,
  Eye,
  EyeOff,
  MousePointer2,
  Pencil,
  Square,
  Settings,
  X,
  Trash2,
  Undo2,
} from "lucide-react";
import { Viewport } from "@/components/studio/viewport";
import { CATALOG } from "@/lib/studio/catalog";
import { useStudio } from "@/lib/studio/store";
import type { Annotation, Finish, PickHit, TargetRef, Tool, ViewportHandle, SelectionVolume, SelectionRegion } from "@/lib/studio/types";
import { isC4d, sourceInfo } from '@/lib/studio/source';
import { referenceNumbers } from '@/lib/studio/annotation-numbers';
import { SHORTCUTS, DEFAULT_SHORTCUTS, loadShortcuts, saveShortcuts, shortcutFromEvent, shortcutLabel, type ShortcutId, type ShortcutMap } from '@/lib/studio/shortcuts';

const TOOLS: { id: Tool; label: string; hint: string; icon: typeof Eye }[] = [
  { id: "look", label: "观察", hint: "转动视角", icon: Eye },
  { id: "pick", label: "点选", hint: "再次点击取消", icon: MousePointer2 },
  { id: "box", label: "框选", hint: "保留所有命中", icon: Square },
  { id: "volume", label: "三维框", hint: "选择空间", icon: Box },
  { id: "frame", label: "整幅", hint: "不绑定单个物体", icon: AppWindow },
];

const AXES: { axis: "x" | "y" | "z"; delta: number; label: string }[] = [
  { axis: "x", delta: -0.04, label: "左" },
  { axis: "x", delta: 0.04, label: "右" },
  { axis: "y", delta: 0.04, label: "升" },
  { axis: "y", delta: -0.04, label: "降" },
  { axis: "z", delta: 0.04, label: "近" },
  { axis: "z", delta: -0.04, label: "远" },
];

const FINISH_BUTTONS: { id: Finish; label: string }[] = [
  { id: "ceramic", label: "陶瓷" },
  { id: "brass", label: "黄铜" },
  { id: "matte", label: "哑光" },
  { id: "oak", label: "橡木" },
  { id: "restore", label: "还原" },
];

const sourceLabel = isC4d ? "C4D" : "Blender";

function percent(value: number | null) {
  if (value == null) return null;
  return `${Math.max(1, Math.round(value * 100))}%`;
}

function bindBoxHits(hits: PickHit[], sceneUid: string | null): TargetRef[] {
  return hits.map(({ materialName: _materialName, point: _point, ...item }) => ({ ...item, sceneUid, included: item.role !== 'surface' }));
}

function isBound(item: TargetRef) {
  return item.included !== false;
}

function explicitlyNamed(text: string, name: string) {
  const index = text.indexOf(name);
  if (index < 0) return false;
  return !/(?:不要|不能|别|不改|不动|放在|放到|置于|位于|在|到|于)\s*$/.test(text.slice(Math.max(0, index - 8), index));
}

export function Workbench() {
  const viewRef = useRef<ViewportHandle>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>({...DEFAULT_SHORTCUTS});
  const [shortcutSettings, setShortcutSettings] = useState(false);
  const [viewSettings,setViewSettings]=useState({fov:42,nearFactor:1});
  const [settingsTab,setSettingsTab]=useState<"view"|"shortcuts">("view");
  const [shortcutDraft,setShortcutDraft]=useState<ShortcutMap>({...DEFAULT_SHORTCUTS});
  const [capturing,setCapturing]=useState<ShortcutId|null>(null);
  const [savingSettings,setSavingSettings]=useState(false);
  const [settingsError,setSettingsError]=useState('');
  const viewTouched=useRef(false);
  const viewTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const viewQueue=useRef(Promise.resolve());
  const viewSaveError=useRef(false);

  const [toast, setToast] = useState<{id:number;text:string}|null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(text:string) {
    if(toastTimer.current) clearTimeout(toastTimer.current);
    setToast({id:Date.now(),text});
    toastTimer.current=setTimeout(()=>setToast(null),2000);
  }
  useEffect(()=>()=>{if(toastTimer.current)clearTimeout(toastTimer.current);},[]);
  useEffect(()=>{let active=true;fetch('/__point_edit_3d/view-settings',{headers:{'X-Point-Edit':'view-settings'}}).then(r=>r.ok?r.json():null).then(data=>{const v=data?.settings;if(active&&!viewTouched.current&&v&&Number.isFinite(v.fov)&&v.fov>=30&&v.fov<=100&&Number.isFinite(v.nearFactor)&&v.nearFactor>=.1&&v.nearFactor<=10)setViewSettings({fov:v.fov,nearFactor:v.nearFactor});}).catch(()=>{});return()=>{active=false;};},[]);
  function updateView(next:{fov:number;nearFactor:number}) {
    viewTouched.current=true;setViewSettings(next);if(viewTimer.current)clearTimeout(viewTimer.current);
    viewTimer.current=setTimeout(()=>{viewTimer.current=null;viewQueue.current=viewQueue.current.catch(()=>{}).then(async()=>{const r=await fetch('/__point_edit_3d/view-settings',{method:'POST',headers:{'Content-Type':'application/json','X-Point-Edit':'view-settings'},body:JSON.stringify(next)});if(!r.ok)throw new Error('视野设置未能保存');viewSaveError.current=false;setSettingsError('');}).catch(()=>{viewSaveError.current=true;setSettingsError('视野设置未能保存，请重试');});},300);
  }

  const [sceneStatus,setSceneStatus]=useState(isC4d ? '正在连接 C4D…' : '正在加载 Blender 快照…');
  const [identityStatus, setIdentityStatus] = useState('等待场景');
  const [compatibilityNotice,setCompatibilityNotice]=useState('');
  const identityRef = useRef<{sceneUid:string;uids:string[]} | null>(null);
  const pointHighlightIds=useStudio(s=>s.pointSelectionIds);
  const selectionVolumes=useStudio(s=>s.selectionVolumes);
  const setPointHighlightIds=(value:string[]|((ids:string[])=>string[]))=>useStudio.setState(s=>({pointSelectionIds:typeof value==='function'?value(s.pointSelectionIds):value}));
  const selectionHistory = useRef<{selection:TargetRef[]; hit:PickHit|null; scope:'objects'|'viewport'; highlights:string[]; hidden:string[]; volumes:SelectionRegion[]; volume:SelectionVolume|null}[]>([]);
  const [canUndoSelection, setCanUndoSelection] = useState(false);
  const [boxSampling, setBoxSampling] = useState(false);
  const [volumeMode,setVolumeMode]=useState<'translate'|'scale'>('translate');
  const [volumePlaced,setVolumePlaced]=useState(false);
  const [volumeDirty,setVolumeDirty]=useState(false);
  function rememberSelection() {
    const state = useStudio.getState();
    selectionHistory.current.push({selection:state.selection, hit:state.hit, scope:state.scope, highlights:state.pointSelectionIds,hidden:state.hiddenPointIds,volumes:state.selectionVolumes, volume:state.selectionVolume});
    if (selectionHistory.current.length > 50) selectionHistory.current.shift();
    setCanUndoSelection(true);
  }
  function undoSelection() {
    const previous = selectionHistory.current.pop();
    if (!previous) return;
    const currentTool = useStudio.getState().tool;
    if (currentTool === 'volume') { viewRef.current?.cancelVolume(); setVolumeDirty(false); }
    useStudio.setState({selection:previous.selection, hit:previous.hit, scope:previous.scope, selectionVolume:previous.volume, selectionVolumes:previous.volumes,pointSelectionIds:previous.highlights,hiddenPointIds:previous.hidden, tool:previous.scope === 'viewport' ? 'frame' : currentTool === 'frame' ? 'pick' : currentTool});
    setCanUndoSelection(selectionHistory.current.length > 0);
  }
  function focusNote(id: string) {
    rememberSelection();
    useStudio.getState().focusAnnotation(id);
  }
  async function checkIdentity() {
    const info = identityRef.current;
    if (!info) { setIdentityStatus('旧快照：无稳定编号'); return; }
    setIdentityStatus(`正在检查 ${sourceLabel} 连接…`);
    try {
      const response = await fetch('/__point_edit_3d/identity', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...info, source: isC4d ? 'c4d' : 'blender'})});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('offline');
      if (!data.result.scene_matches) setIdentityStatus(`${sourceLabel} 已连接，场景身份不匹配`);
      else if (data.result.objects.some((item:{resolved:boolean}) => !item.resolved)) setIdentityStatus(isC4d ? '场景匹配，但有个别物体编号已失效（可能在 C4D 中撤销或重建），建议重新打开预览' : '场景匹配，但有物体编号未解析');
      else setIdentityStatus(`${sourceLabel} 已连接 · ${data.result.objects.length} 个编号已匹配`);
    } catch { setIdentityStatus(`${sourceLabel} 未连接或插件版本未更新`); }
  }
  useEffect(()=>{const loaded=(event:Event)=>{const detail=(event as CustomEvent).detail; setSceneStatus(`已读取 ${isC4d ? "C4D" : "Blender"} 当前场景 · ${CATALOG.length} 个对象`); const c=detail.compatibility;const notes=[];if(Array.isArray(c?.approximate_materials)&&c.approximate_materials.length)notes.push(isC4d ? `${c.approximate_materials.length} 个材质不是标准材质，预览为近似显示` : `${c.approximate_materials.length} 种材质使用视口颜色近似`);if(c?.has_instances)notes.push(isC4d ? '几何实例按当前求值结果导出' : '几何实例可能未完整显示');if(Array.isArray(c?.warnings))for(const warning of c.warnings)if(typeof warning==='string'&&warning)notes.push(warning);setCompatibilityNotice(notes.join('；')); useStudio.getState().setSceneUid(detail.sceneUid); identityRef.current=detail.sceneUid && detail.allStable ? {sceneUid:detail.sceneUid,uids:detail.uids} : null; void checkIdentity();}; const failed=(event:Event)=>{const detail=(event as CustomEvent).detail; setSceneStatus(typeof detail==='string' ? detail : isC4d ? '无法读取 C4D 场景：请确认 C4D 已启动，并且 C4D MCP 插件已加载' : '无法读取场景，请启用 Blender 的 Point Edit 3D 插件'); setIdentityStatus('预览未载入'); useStudio.getState().setSceneUid(null);}; window.addEventListener('point-edit-scene-loaded',loaded); window.addEventListener('point-edit-scene-error',failed); return ()=>{window.removeEventListener('point-edit-scene-loaded',loaded);window.removeEventListener('point-edit-scene-error',failed)}},[]);
  const tool = useStudio((s) => s.tool);
  const scope = useStudio((s) => s.scope);
  const selection = useStudio((s) => s.selection);
  const selectionVolume = useStudio((s) => s.selectionVolume);
  const hit = useStudio((s) => s.hit);
  const draftIntent = useStudio((s) => s.draftIntent);
  const draftText = useStudio((s) => s.draftText);
  const annotations = useStudio((s) => s.annotations);
  const revision = useStudio((s) => s.revision);
  const sceneUid = useStudio((s) => s.sceneUid);
  const setTool = useStudio((s) => s.setTool);
  const setSelection = useStudio((s) => s.setSelection);
  const clearSelection = useStudio((s) => s.clearSelection);
  const armViewport = useStudio((s) => s.armViewport);
  const setDraftIntent = useStudio((s) => s.setDraftIntent);
  const setDraftText = useStudio((s) => s.setDraftText);
  const saveDraft = useStudio((s) => s.saveDraft);
  const hydrate = useStudio((s) => s.hydrate);
  const bridgeStatus = useStudio((s) => s.bridgeStatus);
  const retryBridge = useStudio((s) => s.retryBridge);

  useEffect(() => {
    hydrate();
  }, [hydrate]);
  useEffect(() => { let active=true; loadShortcuts().then(value=>{if(active)setShortcuts(value);}).catch(()=>{}); return ()=>{active=false;}; }, []);

  const bound = selection.filter(isBound);
  const selectedIds = bound.map((item) => item.objectId);
  // Saved overlays are presentation only and never become targets of the next draft.
  const savedNotes = useMemo(() => sceneUid ? annotations.filter(note => note.sceneUid === sceneUid) : [], [annotations, sceneUid]);
  const displayRegions = useMemo(() => [...savedNotes.filter(note => note.highlightVisible !== false).flatMap(note => (note.selectionVolumes ?? []).map(region => ({...region, visible:true, id:`saved:${note.id}:${region.id}`, intent:note.intent}))), ...selectionVolumes.map(region => ({...region, visible:true}))], [savedNotes, selectionVolumes]);
  const visiblePoints: Record<string, 'question' | 'edit'> = {};
  for (const note of [...savedNotes].reverse()) if (note.highlightVisible !== false) for (const id of note.pointSelectionIds ?? []) visiblePoints[id] = note.intent;
  for (const id of pointHighlightIds) if (selectedIds.includes(id)) visiblePoints[id] = draftIntent;
  const canSave = draftText.trim().length > 0 && (scope === "viewport" || bound.length > 0) && !(tool==='volume' && volumeDirty) && !boxSampling;

  function removePoint(id: string) {
    rememberSelection();
    const current = useStudio.getState();
    const retained = current.selectionVolumes.some(region => region.objectIds.includes(id));
    useStudio.setState({pointSelectionIds:current.pointSelectionIds.filter(value=>value!==id), hiddenPointIds:[], selection:retained ? current.selection : current.selection.filter(item=>item.objectId!==id), hit:null});
  }

  function togglePick(hits: PickHit[], primary: typeof hit) {
    if (tool === "box") {
      const next = bindBoxHits(hits, sceneUid);
      rememberSelection();
      const previous=useStudio.getState();
      const preserved=previous.selection.filter(item=>previous.pointSelectionIds.includes(item.objectId)||previous.selectionVolumes.some(region=>region.objectIds.includes(item.objectId)));
      setSelection([...preserved,...next.filter(item=>!preserved.some(old=>old.objectId===item.objectId))], null, previous.selectionVolume);
      return;
    }
    const only = hits[0];
    if (!only) return;
    if (pointHighlightIds.includes(only.objectId)) { removePoint(only.objectId); return; }
    rememberSelection();
    const exists = selection.some((item) => item.objectId === only.objectId);
    setPointHighlightIds((ids) => [...ids, only.objectId]);
    const next = exists ? selection.map(item=>item.objectId===only.objectId?{...item,included:true,role:'object' as const}:item)
      : [...selection, { objectId: only.objectId, name: only.name, coverage: null, sceneUid, point: only.point, instanceId: only.instanceId,role:'object' as const }];
    setSelection(next, primary, useStudio.getState().selectionVolume);
  }

  useEffect(() => {
    function runShortcut(data: {code:string;key:string;ctrlKey:boolean;altKey:boolean;shiftKey:boolean;metaKey:boolean;repeat?:boolean;isComposing?:boolean}, event?:KeyboardEvent) {
      if (shortcutSettings || data.repeat || data.isComposing) return;
      if (event) { const target=event.target as HTMLElement | null; if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')) return; }
      const key=shortcutFromEvent(data); if (!key) return;
      const action=(Object.keys(shortcuts) as ShortcutId[]).find(id=>shortcuts[id]===key);
      if (!action) return;
      if (['move','scale','confirm','reset'].includes(action) && tool !== 'volume') return;
      if ((action==='confirm'||action==='reset') && (!volumePlaced || boxSampling)) return;
      if (action==='undo' && (!canUndoSelection || boxSampling)) return;
      event?.preventDefault();
      if (action==='undo') undoSelection();
      else if (action==='move') setVolumeMode('translate');
      else if (action==='scale') setVolumeMode('scale');
      else if (action==='confirm') viewRef.current?.confirmVolume();
      else if (action==='reset') viewRef.current?.resetVolume();
      else { if (action==='frame' && scope!=='viewport') rememberSelection(); setTool(action); }
    }
    const onKey=(event:KeyboardEvent)=>runShortcut(event,event);
    window.addEventListener('keydown',onKey);
    return ()=>{window.removeEventListener('keydown',onKey);};
  }, [shortcuts, shortcutSettings, tool, volumePlaced, boxSampling, canUndoSelection, scope, selection, selectionVolumes, pointHighlightIds]);

  function exportNotes() {
    const payload = {
      app: "point-edit-3d",
      target: isC4d ? 'c4d' : 'blender',
      source: sourceInfo,
      scene: sourceInfo.name,
      file: sourceInfo.file,
      revision,
      annotations: annotations.map((note) => ({
        id: note.id,
        number: note.number,
        sceneUid: note.sceneUid ?? null,
        identity: note.identity ?? 'snapshot_only',
        sourceRevision: note.sourceRevision ?? null,
        references: referenceNumbers(note.text).map((number) => {
          const referred = annotations.find((candidate) => candidate.number === number);
          return referred ? { number, id: referred.id, text: referred.text, intent: referred.intent, targets: referred.targets } : { number, missing: true };
        }),
        intent: note.intent === "question" ? "question" : "edit",
        text: note.text,
        scope: note.scope,
        selectionVolume: note.selectionVolume ?? null,
        selectionVolumes: note.selectionVolumes ?? [],
        pointSelectionIds: note.pointSelectionIds ?? [],
        hiddenPointIds: note.hiddenPointIds ?? [],
        objects: note.targets.filter(item => item.role !== 'surface').map(item => ({...item, rays: undefined, mentioned: explicitlyNamed(note.text, item.name), textOrder: note.text.indexOf(item.name)})),
        surfaces: note.targets.filter(item => item.role === 'surface').map(item => ({ objectId: item.objectId, objectName: item.name, coverage: item.coverage, depth: item.depth, score: item.score, points: item.samples?.map(sample => sample.point) ?? [] })),
        rays: note.targets.find(item => item.rays)?.rays ?? [],
        reply: note.reply,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "point-edit-3d.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <img src="/point-edit-3d-icon-v4.svg" alt="" className="h-9 w-9 shrink-0 rounded-md" />
        <div className="min-w-0">
          <p className="truncate text-base font-medium leading-tight">Point Edit 3D</p>
          <p className="text-xs text-muted">
            {sceneStatus} · 仅预览 · 修订 {revision}
          </p>
          {compatibilityNotice && <p className="text-xs text-amber-400">预览提示：{compatibilityNotice}</p>}
          {<button type="button" onClick={() => void checkIdentity()} className="text-left text-xs text-muted" title={`点击重新检查 ${sourceLabel} 连接`}>{identityStatus} · 重新检查</button>}
        </div>
        <button
          type="button"
          onClick={exportNotes}
          className="ml-auto inline-flex h-11 items-center gap-2 rounded-md border border-line bg-raised px-3 text-sm text-fg"
        >
          <Download className="size-4" />
          导出
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative h-96 shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
          <Viewport
            ref={viewRef}
            fov={viewSettings.fov}
            nearFactor={viewSettings.nearFactor}
            tool={tool}
            intent={draftIntent}
            selectedIds={Object.keys(visiblePoints)}
            selectedIntents={visiblePoints}
            onPick={(hits, primary) => togglePick(hits, primary)}
            onEmpty={() => { if (pointHighlightIds.length || selectionVolumes.length) return; if (selection.length || scope === 'viewport') rememberSelection(); clearSelection(); }}
            onFrame={() => { if (scope !== 'viewport') rememberSelection(); armViewport(); }}
            volumeMode={volumeMode}
            onVolume={(hits,volume)=>{rememberSelection();const current=useStudio.getState();const added=hits.map(({materialName:_materialName,point:_point,...item})=>({...item,sceneUid,included:true}));const region:SelectionRegion={id:crypto.randomUUID(),volume,objectIds:added.map(item=>item.objectId),visible:true};useStudio.setState({selectionVolumes:[...current.selectionVolumes,region]});setSelection([...current.selection,...added.filter(item=>!current.selection.some(old=>old.objectId===item.objectId))],null,volume);}}
            onVolumeState={(placed,dirty)=>{setVolumePlaced(placed);setVolumeDirty(dirty);}}
            regions={displayRegions}
          />
          <div className="pointer-events-none absolute left-3 top-3 max-w-[70%] rounded-md bg-bg/80 px-3 py-2 text-xs text-muted">
            {tool === 'volume' ? (!volumePlaced ? '点击物体放置三维框；中键旋转，右键平移。' : volumeDirty ? '拖动手柄调整后，点击“确认选区”。' : '已确认三维选区；可点击对象名称排除。') : scope === "viewport"
              ? "整幅视口，不绑定单个物体"
              : selection.some((item) => item.role === 'surface')
                ? `对象：${bound.map((item) => item.name).join("、") || "无"}；表面仅记录落点。`
                : hit
                  ? `命中 ${hit.name} · ${hit.point.map((n) => n.toFixed(2)).join(", ")}`
                  : "点选可累积；中键旋转，右键平移，滚轮缩放。"}
          </div>
          {tool==='volume' && <div className="absolute left-3 top-16 flex flex-wrap gap-2 rounded-lg border border-line bg-surface/95 p-2 text-xs">
            <button type="button" title={`快捷键 ${shortcutLabel(shortcuts.move)}`} onClick={()=>setVolumeMode('translate')} aria-pressed={volumeMode==='translate'} className={`hover-ring rounded px-3 py-2 ${volumeMode==='translate'?'bg-fg text-bg':'text-fg'}`}>移动</button>
            <button type="button" title={`快捷键 ${shortcutLabel(shortcuts.scale)}`} onClick={()=>setVolumeMode('scale')} aria-pressed={volumeMode==='scale'} className={`hover-ring rounded px-3 py-2 ${volumeMode==='scale'?'bg-fg text-bg':'text-fg'}`}>调整尺寸</button>
            <button type="button" disabled={!volumePlaced || boxSampling} title={`快捷键 ${shortcutLabel(shortcuts.confirm)}`} onClick={()=>viewRef.current?.confirmVolume()} className={`hover-ring rounded px-3 py-2 text-bg disabled:opacity-40 ${draftIntent==='edit' ? 'bg-edit' : 'bg-ask'}`}>确认选区</button>
            <button type="button" disabled={!volumePlaced || boxSampling} title={`快捷键 ${shortcutLabel(shortcuts.reset)}`} onClick={()=>viewRef.current?.resetVolume()} className="hover-ring rounded border border-line px-3 py-2 text-fg disabled:opacity-40">重新放置</button>
          </div>}
          <div className="absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="flex max-w-full gap-1 rounded-lg border border-line bg-surface/95 p-1">
              <div className="flex min-w-0 gap-1 overflow-x-auto">
              {TOOLS.map((item) => {
                const Icon = item.icon;
                const on = tool === item.id;
                return (
                  <button
                    key={item.id}
                    title={`快捷键 ${shortcutLabel(shortcuts[item.id])}`}
                    type="button"
                    aria-pressed={on}
                    onClick={() => { if (item.id === 'frame' && scope !== 'viewport') rememberSelection(); setTool(item.id); }}
                    className={`hover-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm ${on ? "bg-fg text-bg" : "text-fg"}`}
                  >
                    <Icon className="size-4" />
                    <span>{item.label}</span>
                    <span className={`hidden text-xs sm:inline ${on ? "text-bg/70" : "text-muted"}`}>{item.hint}</span>
                  </button>
                );
              })}
              </div>
              <button type="button" onClick={undoSelection} disabled={!canUndoSelection || boxSampling} aria-label="撤销选择" title={boxSampling ? '等待框选采样完成' : `撤销上一次选择 · ${shortcutLabel(shortcuts.undo)}`} className="hover-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-fg disabled:opacity-40">
                <Undo2 className="size-4" /><span>撤销</span>
              </button>
            </div>
          </div>
        </section>

        <aside className="studio-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-line bg-surface p-4 lg:w-96 lg:flex-none lg:border-t-0 lg:border-l">
          <section className="flex flex-col gap-3">
            {selectionVolumes.length>0 && <div className="flex flex-wrap gap-2" aria-label="已确认的三维框">{selectionVolumes.map((region,index)=><span key={region.id} className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg">三维框 {index+1}</span>)}</div>}
            <div className="flex flex-wrap gap-2">
              {scope === "viewport" ? (
                <span className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg">整幅视口</span>
              ) : selection.length === 0 ? (
                <span className="text-sm text-muted">还没有选中物体</span>
              ) : (
                selection.map((item) => {
                  const on = isBound(item);
                  return (
                    <button
                      key={item.objectId}
                      type="button"
                      onClick={() => { if(pointHighlightIds.includes(item.objectId)){removePoint(item.objectId);return;} rememberSelection(); item.coverage != null ? setSelection(selection.map(row => row.objectId === item.objectId ? {...row, role: row.role === 'surface' ? 'object' : 'surface', included: row.role === 'surface'} : row), hit, selectionVolume) :
                        setSelection(
                          selection.map((row) =>
                            row.objectId === item.objectId ? { ...row, included: !on } : row,
                          ),
                          hit, selectionVolume,
                        );
                      }
                      }
                      className={`rounded-md border px-2 py-1 text-xs ${
                        on ? "border-line bg-raised text-fg" : "border-dashed border-line text-muted"
                      }`}
                    >
                      {item.name}
                      {percent(item.coverage) ? ` ${percent(item.coverage)}` : ""}
                      {item.role === 'surface' ? ' · 落点' : item.coverage != null ? ' · 对象' : on ? "" : " · 未纳入"}
                    </button>
                  );
                })
              )}
            </div>
            {selection.some((item) => item.included === false && item.role !== 'surface') ? (
              <p className="text-xs leading-relaxed text-muted">
                未纳入的对象不会进入修改范围。
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <IntentButton intent="question" current={draftIntent} onClick={() => setDraftIntent("question")} />
              <IntentButton intent="edit" current={draftIntent} onClick={() => setDraftIntent("edit")} />
            </div>
            <textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              rows={3}
              placeholder={draftIntent === "question" ? "这几个物体的比例和光线协不协调？" : "杯子偏大，木纹方向不对"}
              className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg outline-none"
            />
            <button
              type="button"
              disabled={!canSave}
              onClick={() => { if (saveDraft()) { viewRef.current?.cancelVolume(); selectionHistory.current = []; setCanUndoSelection(false); } }}
              className={`hover-ring h-11 rounded-md text-sm font-medium text-bg disabled:opacity-40 ${draftIntent === "edit" ? "bg-edit" : "bg-ask"}`}
            >
              记下这条批注
            </button>
            <p className="text-xs text-muted" role="status">
              {bridgeStatus === 'sent' ? '批注已提交，可回到工作区说“继续”。' : bridgeStatus === 'sending' ? '正在交接批注…' : bridgeStatus === 'error' ? '交接失败：批注仍保存在本浏览器。' : '保存批注后会自动交接给工作区'}
              {bridgeStatus === 'error' && <button type="button" onClick={retryBridge} className="ml-2 text-ask underline">重试</button>}
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">批注</h2>
              {annotations.some(note => (note.pointSelectionIds?.length ?? 0) > 0 || (note.selectionVolumes?.length ?? 0) > 0) && <button type="button" aria-label={annotations.some(note => note.highlightVisible !== false && ((note.pointSelectionIds?.length ?? 0) > 0 || (note.selectionVolumes?.length ?? 0) > 0)) ? '隐藏全部批注高亮' : '显示全部批注高亮'} onClick={() => useStudio.getState().setAllAnnotationHighlights(!annotations.some(note => note.highlightVisible !== false && ((note.pointSelectionIds?.length ?? 0) > 0 || (note.selectionVolumes?.length ?? 0) > 0)))} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted">{annotations.some(note => note.highlightVisible !== false && ((note.pointSelectionIds?.length ?? 0) > 0 || (note.selectionVolumes?.length ?? 0) > 0)) ? <><Eye className="size-4"/>隐藏全部高亮</> : <><EyeOff className="size-4"/>显示全部高亮</>}</button>}
              <span className="text-xs text-muted">{annotations.length} 条</span>
            </div>
            {annotations.length === 0 ? (
              <p className="text-sm leading-relaxed text-muted">
                每条批注单独保存。框选保留所有命中；后方表面只记录落点。整幅只附当前视角。
              </p>
            ) : (
              annotations.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  number={note.number}
                  onFocus={() => focusNote(note.id)}
                  onMutate={() => useStudio.getState().markMutation()}
                  view={viewRef}
                />
              ))
            )}
          </section>

          <details className="border-t border-line pt-3 text-sm">
            <summary className="cursor-pointer text-muted">快照节点编号（重导出或改名可能变化）</summary>
            <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted">
              {CATALOG.map((item) => (
                <li key={item.id}>
                  {item.name} · {item.id} · {item.material}
                </li>
              ))}
            </ul>
          </details>
        </aside>
      </div>
      <div className="fixed bottom-4 right-4 z-20">
        <button type="button" aria-label="设置" onClick={()=>{setSettingsTab('view');setShortcutDraft({...shortcuts});setCapturing(null);setShortcutSettings(true);}} className="hover-ring inline-flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-xs text-fg shadow-lg"><Settings size={16}/>设置</button>
      </div>
      {shortcutSettings && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="presentation">
        <div role="dialog" aria-modal="true" aria-label="设置" className="settings-dialog relative flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-lg font-medium">设置</h2><p className="mt-1 text-xs text-muted">根据使用习惯调整预览与操作</p></div><button type="button" aria-label="关闭设置" onClick={()=>setShortcutSettings(false)} className="rounded p-2 text-muted hover:bg-raised hover:text-fg"><X size={19}/></button></div>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav aria-label="设置分类" className="flex gap-2 border-b border-line p-3 sm:w-44 sm:shrink-0 sm:flex-col sm:border-b-0 sm:border-r">
              <button type="button" onClick={()=>setSettingsTab('view')} aria-pressed={settingsTab==='view'} className={`hover-ring rounded-md px-3 py-3 text-left text-sm ${settingsTab==='view'?'bg-ask/15 text-ask':'text-muted hover:bg-raised hover:text-fg'}`}>视野设置</button>
              <button type="button" onClick={()=>setSettingsTab('shortcuts')} aria-pressed={settingsTab==='shortcuts'} className={`hover-ring rounded-md px-3 py-3 text-left text-sm ${settingsTab==='shortcuts'?'bg-ask/15 text-ask':'text-muted hover:bg-raised hover:text-fg'}`}>自定义键位</button>
            </nav>
            <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-6">
              <div hidden={settingsTab!=='view'} role="group" aria-label="视野设置">
                <h3 className="text-base font-medium">视野设置</h3><p className="mt-1 text-xs text-muted">调整预览视角与近景显示，修改后自动保存。</p>
                <div className="mt-6 flex items-center justify-between text-sm"><span>视野角度</span><span>{viewSettings.fov}°</span></div>
                <input aria-label="视野角度" type="range" min="30" max="100" step="1" value={viewSettings.fov} onChange={event=>updateView({...viewSettings,fov:Number(event.target.value)})} className="mt-2 w-full accent-blue-500" />
                <p className="mt-1 text-xs text-muted">角度越大，看到的范围越广。</p>
                <div className="mt-6 flex items-center justify-between text-sm"><span>近景裁剪</span><span>{Number(viewSettings.nearFactor.toPrecision(2))}×</span></div>
                <input aria-label="近景裁剪" type="range" min="0" max="200" step="1" value={Math.round(100+100*Math.log10(viewSettings.nearFactor))} onChange={event=>updateView({...viewSettings,nearFactor:Math.pow(10,(Number(event.target.value)-100)/100)})} className="mt-2 w-full accent-blue-500" />
                <div className="flex justify-between text-xs text-muted"><span>靠得更近</span><span>远景更稳定</span></div>
                <p className="mt-2 text-xs text-muted">仍会随视距自动调整；过小可能让远处表面闪烁。</p>
              </div>
              <div hidden={settingsTab!=='shortcuts'}><ShortcutSettings draft={shortcutDraft} setDraft={setShortcutDraft} capturing={capturing} setCapturing={setCapturing} onToast={showToast} /></div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4">
            {settingsError && <span role="status" className="mr-auto text-xs text-red-400">{settingsError}</span>}
            <button type="button" onClick={()=>{if(settingsTab==='view')updateView({fov:42,nearFactor:1});else {setShortcutDraft({...DEFAULT_SHORTCUTS});setCapturing(null);}}} className="hover-ring rounded border border-line px-3 py-2 text-sm">恢复默认</button>
            <button type="button" onClick={()=>setShortcutSettings(false)} className="hover-ring rounded border border-line px-3 py-2 text-sm">取消</button>
            <button type="button" disabled={capturing!==null || savingSettings} onClick={()=>{setSavingSettings(true);void (async()=>{const pendingView=!!viewTimer.current;if(viewTimer.current){clearTimeout(viewTimer.current);viewTimer.current=null;}await viewQueue.current;if(pendingView || viewSaveError.current){try{const response=await fetch('/__point_edit_3d/view-settings',{method:'POST',headers:{'Content-Type':'application/json','X-Point-Edit':'view-settings'},body:JSON.stringify(viewSettings)});if(!response.ok)throw new Error();viewSaveError.current=false;setSettingsError('');}catch{viewSaveError.current=true;throw new Error('视野设置未能保存');}}if(SHORTCUTS.some(item=>shortcutDraft[item.id]!==shortcuts[item.id])) await saveShortcuts(shortcutDraft);setShortcuts(shortcutDraft);setShortcutSettings(false);showToast('保存成功');})().catch(error=>{const message=error instanceof Error ? error.message : '快捷键未能保存，请重试';if(message==='视野设置未能保存')setSettingsError('视野设置未能保存，请重试');else showToast(message);}).finally(()=>setSavingSettings(false));}} className="hover-ring rounded bg-ask px-3 py-2 text-sm text-bg disabled:opacity-40">保存</button>
          </div>
          {toast && <div key={toast.id} role="status" aria-live="polite" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"><div className="shortcut-toast rounded-lg bg-black/85 px-6 py-3 text-sm font-medium text-white shadow-lg">{toast.text}</div></div>}
        </div>
      </div>}
      {toast && !shortcutSettings && <div key={toast.id} role="status" aria-live="polite" className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center"><div className="shortcut-toast rounded-lg bg-black/85 px-6 py-3 text-sm font-medium text-white shadow-lg">{toast.text}</div></div>}
    </div>
  );
}

function ShortcutSettings({draft,setDraft,capturing,setCapturing,onToast}:{draft:ShortcutMap;setDraft:React.Dispatch<React.SetStateAction<ShortcutMap>>;capturing:ShortcutId|null;setCapturing:React.Dispatch<React.SetStateAction<ShortcutId|null>>;onToast:(message:string)=>void}) {
  function capture(id:ShortcutId,event:ReactKeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();event.stopPropagation();
    if(event.key==='Escape'){setCapturing(null);return;}
    const key=shortcutFromEvent(event.nativeEvent);if(!key)return;
    const duplicate=SHORTCUTS.find(item=>item.id!==id && draft[item.id]===key);
    if(duplicate){onToast(`${shortcutLabel(key)} 已分配给“${duplicate.label}”`);return;}
    setDraft(current=>({...current,[id]:key}));setCapturing(null);
  }
  return <div>
      <h3 className="text-base font-medium">自定义键位</h3><p className="mt-1 text-xs text-muted">点击键位后按下新快捷键；Esc 取消录入。输入文字时快捷键不会触发。</p>
      <div className="mt-4 flex flex-col gap-2">{SHORTCUTS.map(item=><div key={item.id} className="flex items-center justify-between gap-4 text-sm"><span>{item.label}</span><button type="button" aria-label={`设置${item.label}快捷键`} aria-pressed={capturing===item.id} onClick={()=>{setCapturing(item.id);}} onKeyDown={event=>{if(capturing===item.id)capture(item.id,event);}} className={`hover-ring min-w-28 rounded border px-3 py-2 text-xs ${capturing===item.id?'border-ask text-ask':'border-line text-fg'}`}>{capturing===item.id?'请按快捷键…':shortcutLabel(draft[item.id])}</button></div>)}</div>

  </div>;
}

function IntentButton({
  intent,
  current,
  onClick,
}: {
  intent: "question" | "edit";
  current: "question" | "edit";
  onClick: () => void;
}) {
  const on = current === intent;
  const question = intent === "question";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-md border text-sm ${
        on
          ? question
            ? "border-ask bg-ask/15 text-ask"
            : "border-edit bg-edit/15 text-edit"
          : "border-line text-muted"
      }`}
    >
      {question ? "询问" : "编辑"}
    </button>
  );
}

function NoteCard({
  note,
  number,
  onFocus,
  onMutate,
  view,
}: {
  note: Annotation;
  number: number;
  onFocus: () => void;
  onMutate: () => void;
  view: RefObject<ViewportHandle | null>;
}) {
  const [targetId, setTargetId] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBase, setEditBase] = useState('');
  const [editNotice, setEditNotice] = useState('');
  const [pendingTargets, setPendingTargets] = useState<TargetRef[] | undefined>();
  const [pendingVolume, setPendingVolume] = useState<SelectionVolume | null>(null);
  const [pendingRegions, setPendingRegions] = useState<SelectionRegion[]>([]);
  const [pendingPoints, setPendingPoints] = useState<string[]>([]);
  const [pendingHidden, setPendingHidden] = useState<string[]>([]);
  const currentSelection = useStudio(s => s.selection);
  const currentScope = useStudio(s => s.scope);
  const currentScene = useStudio(s => s.sceneUid);
  const canUpdateTargets = note.scope === 'objects' && currentScope === 'objects' && !!note.sceneUid && note.sceneUid === currentScene && currentSelection.some(item => item.included !== false) && currentSelection.every(item => item.sceneUid === currentScene);
  const question = note.intent === "question";
  // Until object/surface roles are resolved, never offer whole-object edits for box hits.
  const editable = note.identity === 'web_scene' ? [] : note.targets.filter((item) => isBound(item) && item.role !== 'surface' && item.coverage == null && explicitlyNamed(note.text, item.name));
  const active = editable.find((item) => item.objectId === targetId);

  function run(action: () => void) {
    action();
    onMutate();
  }

  return (
    <article data-annotation-id={note.id} className={`rounded-md border bg-bg p-3 ${question ? "border-ask" : "border-edit"}`}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onFocus}
          className={`text-xs ${question ? "text-ask" : "text-edit"}`}
        >
          {number === 0 ? "0" : number <= 20 ? String.fromCodePoint(0x2460 + number - 1) : `(${number})`} {question ? "询问" : "编辑"}
          {note.scope === "viewport" ? " · 整幅" : ""}
        </button>
        {((note.pointSelectionIds?.length ?? 0) > 0 || (note.selectionVolumes?.length ?? 0) > 0) && <button type="button" aria-label={`${note.highlightVisible === false ? '显示' : '隐藏'}批注${number}高亮`} title={note.highlightVisible === false ? '显示高亮' : '隐藏高亮'} onClick={() => useStudio.getState().setAnnotationHighlight(note.id, note.highlightVisible === false)} className="inline-flex items-center gap-1 text-xs text-muted">{note.highlightVisible === false ? <><EyeOff className="size-4"/>显示高亮</> : <><Eye className="size-4"/>隐藏高亮</>}</button>}
        <span className="ml-auto text-xs text-muted">
          {new Date(note.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <button type="button" aria-label="编辑批注" title="编辑批注" onClick={() => { setEditText(note.text); setEditBase(note.text); setEditNotice(''); setPendingTargets(undefined); setPendingVolume(null); setEditing(true); }} className="text-muted"><Pencil className="size-4" /></button>
        <button
          type="button"
          aria-label="删除批注"
          onClick={() => useStudio.getState().removeAnnotation(note.id)}
          className="text-muted"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {note.targets.length === 0 ? (
          <span className="text-xs text-muted">整幅视口</span>
        ) : (
          note.targets.map((item) => {
            const inSentence = isBound(item);
            return (
              <TargetChip
                key={item.objectId}
                item={item}
                active={!question && inSentence && active?.objectId === item.objectId}
                dimmed={!inSentence}
                onClick={() => {
                  if (!inSentence) return;
                  setTargetId(item.objectId);
                  onFocus();
                }}
              />
            );
          })
        )}
      </div>
        {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea aria-label="编辑批注正文" value={editText} onChange={event => setEditText(event.target.value)} rows={3} className="w-full resize-y rounded-md border border-line bg-bg p-2 text-sm text-fg outline-none" />
          {note.scope === 'objects' && <button type="button" disabled={!canUpdateTargets} onClick={() => { const current=useStudio.getState();setPendingTargets(currentSelection.map(item=>({...item}))); setPendingVolume(current.selectionVolume);setPendingRegions(current.selectionVolumes.map(r=>({...r,objectIds:[...r.objectIds]})));setPendingPoints([...current.pointSelectionIds]);setPendingHidden([...current.hiddenPointIds]); setEditNotice('保存修改时将使用当前选区'); }} className="self-start rounded-md border border-line px-2 py-1 text-xs text-fg disabled:opacity-40">使用当前选区</button>}
          {editNotice && <p className="text-xs text-muted">{editNotice}</p>}
          {note.text !== editBase && <p className="text-xs text-muted">批注已被其他操作更新，请取消后重新编辑。</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!editText.trim() || note.text !== editBase} onClick={() => { if (useStudio.getState().editAnnotation(note.id, editText, pendingTargets, pendingVolume,pendingRegions,pendingPoints,pendingHidden)) setEditing(false); else setEditNotice('保存失败，请重新选择对象'); }} className="rounded-md bg-ask px-3 py-2 text-xs text-bg disabled:opacity-40">保存修改</button>
            <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-line px-3 py-2 text-xs text-fg">取消</button>
          </div>
        </div>
      ) : <p className="mt-2 text-sm leading-relaxed text-fg">{note.text}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => useStudio.getState().setAnnotationIntent(note.id, "question")}
          className={`h-9 rounded-md px-2 text-xs ${question ? "bg-ask/15 text-ask" : "text-muted"}`}
        >
          改成询问
        </button>
        <button
          type="button"
          onClick={() => useStudio.getState().setAnnotationIntent(note.id, "edit")}
          className={`h-9 rounded-md px-2 text-xs ${!question ? "bg-edit/15 text-edit" : "text-muted"}`}
        >
          改成编辑
        </button>
      </div>
      {!question && active ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-muted">
            仅在网页副本中调整 {active.name}
            ，不会写回 {isC4d ? "C4D" : "Blender"}。
          </p>
          <div className="grid grid-cols-4 gap-1">
            {AXES.map((item) => (
              <button
                key={`${item.axis}${item.delta}`}
                type="button"
                onClick={() => run(() => view.current?.nudge(active.objectId, item.axis, item.delta))}
                className="h-10 rounded-md border border-line text-xs text-fg"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => run(() => view.current?.scaleBy(active.objectId, 1.08))}
              className="h-10 rounded-md border border-line text-xs text-fg"
            >
              放大
            </button>
            <button
              type="button"
              onClick={() => run(() => view.current?.scaleBy(active.objectId, 0.92))}
              className="h-10 rounded-md border border-line text-xs text-fg"
            >
              缩小
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {FINISH_BUTTONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => run(() => view.current?.finish(active.objectId, item.id))}
                className="h-9 rounded-md border border-line px-2 text-xs text-fg"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => view.current?.undo()}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-line px-2 text-xs text-fg"
            >
              <Undo2 className="size-3" />
              撤销
            </button>
          </div>
        </div>
      ) : null}
      {note.reply ? <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{note.reply}</p> : null}
    </article>
  );
}

function TargetChip({
  item,
  active,
  dimmed,
  onClick,
}: {
  item: TargetRef;
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs ${
        dimmed ? "text-muted line-through" : active ? "bg-edit/20 text-edit" : "bg-raised text-fg"
      }`}
    >
      {item.name}
      {percent(item.coverage) ? ` ${percent(item.coverage)}` : ""}
      {dimmed ? " · 不改" : ""}
    </button>
  );
}
