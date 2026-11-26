import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { acceleratedRaycast } from "three-mesh-bvh";
import { GenerateMeshBVHWorker } from "three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js";
import { meshIntersectsVolume } from '@/lib/studio/volume-intersection';
import { clippingPlanes } from '@/lib/studio/camera-clipping';
import { pivotRecoveryThreshold, recoveredPivotDistance } from '@/lib/studio/camera-navigation';
import { CATALOG } from "@/lib/studio/catalog";
import { isC4d } from "@/lib/studio/source";
import { classifyBox } from "@/lib/studio/box-classification.js";
import type { Finish, PickHit, RaySample, Tool, ViewportHandle, SelectionVolume, SelectionRegion } from "@/lib/studio/types";

type Rec = {
  id: string;
  name: string;
  materialName: string;
  root: THREE.Group;
  meshes: THREE.Mesh[];
  outlines: LineSegments2[];
  basePos: THREE.Vector3;
  baseScale: THREE.Vector3;
  baseMats: MatSnap[];
};

type MatSnap = {
  color: number;
  roughness: number;
  metalness: number;
  emissive: number;
  emissiveIntensity: number;
};

type UndoFrame = {
  id: string;
  pos: [number, number, number];
  scale: [number, number, number];
  mats: MatSnap[];
};

type Props = {
  tool: Tool;
  fov: number;
  nearFactor: number;
  intent: "question" | "edit";
  selectedIds: string[];
  selectedIntents: Record<string, "question" | "edit">;
  onPick: (hits: PickHit[], hit: PickHit | null) => void;
  onEmpty: () => void;
  onFrame: () => void;
  volumeMode: 'translate' | 'scale';
  onVolume: (hits: PickHit[], volume: SelectionVolume) => void;
  onVolumeState: (placed: boolean, dirty: boolean) => void;
  regions: (SelectionRegion & {intent?: "question" | "edit"})[];
};

const FINISHES: Record<Exclude<Finish, "restore">, { color: number; roughness: number; metalness: number }> = {
  ceramic: { color: 0xf3efe6, roughness: 0.32, metalness: 0.02 },
  brass: { color: 0xb08d57, roughness: 0.32, metalness: 0.78 },
  matte: { color: 0x2c2a28, roughness: 0.92, metalness: 0 },
  oak: { color: 0xa97848, roughness: 0.62, metalness: 0.04 },
};

function snapMat(material: THREE.Material): MatSnap {
  const mat = material as THREE.MeshStandardMaterial;
  return {
    color: mat.color?.getHex?.() ?? 0xffffff,
    roughness: mat.roughness ?? 1,
    metalness: mat.metalness ?? 0,
    emissive: mat.emissive?.getHex?.() ?? 0,
    emissiveIntensity: mat.emissiveIntensity ?? 0,
  };
}

function applySnap(material: THREE.Material, snap: MatSnap) {
  const mat = material as THREE.MeshStandardMaterial;
  if (!mat.color) return;
  mat.color.setHex(snap.color);
  mat.roughness = snap.roughness;
  mat.metalness = snap.metalness;
  mat.emissive?.setHex(snap.emissive);
  mat.emissiveIntensity = snap.emissiveIntensity;
}

function seal(rec: Rec) {
  rec.basePos.copy(rec.root.position);
  rec.baseScale.copy(rec.root.scale);
  rec.baseMats = rec.meshes.map((mesh) => snapMat(mesh.material as THREE.Material));
}

function hitFromMesh(mesh: THREE.Object3D, point: THREE.Vector3, coverage: number | null): PickHit | null {
  let current: THREE.Object3D | null = mesh;
  while (current && !current.userData.uid) current = current.parent;
  if (!current?.userData.uid) return null;
  return {
    objectId: current.userData.uid as string,
    name: current.userData.name as string,
    materialName: (current.userData.materialName as string) ?? "",
    point: [Number(point.x.toFixed(3)), Number(point.y.toFixed(3)), Number(point.z.toFixed(3))],
    coverage,
  };
}

/** Release resources owned by this preview, including textures shared by cloned materials. */
function disposePreview(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<{ close: () => void }>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const value = mesh.material;
    for (const material of Array.isArray(value) ? value : value ? [value] : []) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    const image = texture.source?.data;
    if (image && typeof image.close === 'function') images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const geometry of geometries) geometry.dispose();
}

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(
  { tool, fov, nearFactor, intent, selectedIds, selectedIntents, onPick, onEmpty, onFrame, volumeMode, onVolume, onVolumeState, regions },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool);
  const intentRef = useRef(intent);
  const viewSettingsRef = useRef({fov,nearFactor});
  viewSettingsRef.current = {fov,nearFactor};
  intentRef.current = intent;
  const controlsRef = useRef<OrbitControls | null>(null);
  const recordsRef = useRef<Rec[]>([]);
  const pickablesRef = useRef<THREE.Mesh[]>([]);
  const rayRef = useRef(new THREE.Raycaster());
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const callbacks = useRef({ onPick, onEmpty, onFrame, onVolume, onVolumeState });
  const volumeActions = useRef<{reset:()=>void;cancel:()=>void;confirm:()=>void;setTool:(tool:Tool)=>void;setMode:(mode:'translate'|'scale')=>void;setRegions:(regions:(SelectionRegion & {intent?: "question" | "edit"})[],intent:'question'|'edit')=>void} | null>(null);
  const volumeAppearance = useRef<((intent:'question'|'edit')=>void) | null>(null);
  toolRef.current = tool;
  callbacks.current = { onPick, onEmpty, onFrame, onVolume, onVolumeState };

  useImperativeHandle(ref, () => ({
    resetVolume() { volumeActions.current?.reset(); },
    cancelVolume() { volumeActions.current?.cancel(); },
    confirmVolume() { volumeActions.current?.confirm(); },
    nudge(id, axis, delta) {
      const rec = recordsRef.current.find((item) => item.id === id);
      if (!rec) return;
      pushUndo(rec);
      rec.root.position[axis] += delta;
    },
    scaleBy(id, factor) {
      const rec = recordsRef.current.find((item) => item.id === id);
      if (!rec) return;
      pushUndo(rec);
      const next = THREE.MathUtils.clamp(rec.root.scale.x * factor, 0.45, 2.2);
      rec.root.scale.setScalar(next);
    },
    finish(id, preset) {
      const rec = recordsRef.current.find((item) => item.id === id);
      if (!rec) return;
      pushUndo(rec);
      rec.meshes.forEach((mesh, index) => {
        if (preset === "restore") {
          const base = rec.baseMats[index];
          if (base) applySnap(mesh.material as THREE.Material, base);
          return;
        }
        const spec = FINISHES[preset];
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (!mat.color) return;
        mat.color.setHex(spec.color);
        mat.roughness = spec.roughness;
        mat.metalness = spec.metalness;
      });
    },
    undo() {
      const frame = undoStack.pop();
      if (!frame) return false;
      const rec = recordsRef.current.find((item) => item.id === frame.id);
      if (!rec) return false;
      rec.root.position.set(frame.pos[0], frame.pos[1], frame.pos[2]);
      rec.root.scale.set(frame.scale[0], frame.scale[1], frame.scale[2]);
      rec.meshes.forEach((mesh, index) => {
        const snap = frame.mats[index];
        if (snap) applySnap(mesh.material as THREE.Material, snap);
      });
      return true;
    },
  }));

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const annotate = tool !== "look";
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = annotate ? null : THREE.TOUCH.ROTATE;
    volumeActions.current?.setTool(tool);
  }, [tool]);

  useEffect(() => { volumeActions.current?.setMode(volumeMode); }, [volumeMode]);
  useEffect(() => { volumeActions.current?.setRegions(regions,intent); }, [regions,intent]);

  useEffect(() => {
    const selected = new Set(selectedIds);
    for (const rec of recordsRef.current) {
      const on = selected.has(rec.id);
      for (const line of rec.outlines) { line.visible = on; line.material.color.set((selectedIntents[rec.id] ?? intent) === "edit" ? 0x9e7bff : 0x3b82f6); }
    }
  }, [selectedIds, selectedIntents, intent]);

  useEffect(() => {
    volumeAppearance.current?.(intent);
  }, [intent]);

  useEffect(() => {
    const host = hostRef.current;
    const slot = slotRef.current;
    if (!host || !slot) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    slot.appendChild(renderer.domElement);
    renderer.domElement.className = "h-full w-full touch-none";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x5c5348);


    const camera = new THREE.PerspectiveCamera(viewSettingsRef.current.fov, 1, 0.08, 40);
    const sceneSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    camera.position.set(1.15, 1.22, 1.72);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.78, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI;
    controls.minDistance = 0.01;
    controls.maxDistance = 100000;
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = null;
    controlsRef.current = controls;
    if (import.meta.env.DEV) (window as Window & {__pointEditTesting?:unknown}).__pointEditTesting = {camera,controls};

    const selectionBox = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({color:0x6d8fff,transparent:true,opacity:0.12,depthWrite:false,depthTest:false,side:THREE.DoubleSide}));
    selectionBox.visible=false;
    selectionBox.renderOrder=900;
    const border=new THREE.LineSegments(new THREE.EdgesGeometry(selectionBox.geometry),new THREE.LineBasicMaterial({color:0x8eaeff,depthTest:false}));
    border.renderOrder=901;
    volumeAppearance.current = mode => {
      const color = mode === 'edit' ? 0x9e7bff : 0x3b82f6;
      selectionBox.material.color.setHex(color);
      border.material.color.setHex(color);
    };
    volumeAppearance.current(intentRef.current);
    selectionBox.add(border); scene.add(selectionBox);
    const regionLayer=new THREE.Group(); scene.add(regionLayer);
    const transformer=new TransformControls(camera,renderer.domElement);
    const helper=transformer.getHelper(); scene.add(helper); helper.visible=false; transformer.enabled=false;
    transformer.attach(selectionBox); transformer.setSpace('world'); transformer.setMode('translate');
    let volumePlaced=false;
    const initialPosition=new THREE.Vector3(), initialScale=new THREE.Vector3();
    transformer.addEventListener('dragging-changed', event => { controls.enabled=!event.value; });
    transformer.addEventListener('objectChange', () => { if (volumePlaced) callbacks.current.onVolumeState(true,true); });
    volumeActions.current={
      reset(){if(!volumePlaced)return;selectionBox.position.copy(initialPosition);selectionBox.scale.copy(initialScale);selectionBox.updateMatrixWorld(true);callbacks.current.onVolumeState(true,true);},
      cancel(){volumePlaced=false;selectionBox.visible=false;helper.visible=false;transformer.enabled=false;callbacks.current.onVolumeState(false,false);},
      setRegions(items,mode){
        for(const child of [...regionLayer.children]) {regionLayer.remove(child);disposePreview(child);}
        for(const region of items){
          if(!region.visible)continue;
          const box=new THREE.Box3(new THREE.Vector3(...region.volume.min),new THREE.Vector3(...region.volume.max));
          const color=(region.intent ?? mode)==='edit'?0x9e7bff:0x3b82f6;
          const marker=new THREE.Box3Helper(box,color); (marker.material as THREE.Material).depthTest=false;marker.renderOrder=902;marker.userData.regionId=region.id;regionLayer.add(marker);
        }
      },
      setTool(next){const visible=next==='volume'&&volumePlaced;selectionBox.visible=visible;helper.visible=visible;transformer.enabled=visible;},
      setMode(mode){transformer.setMode(mode);},
      confirm(){
        if(!volumePlaced)return;
        selectionBox.updateMatrixWorld(true);
        const box=new THREE.Box3().setFromObject(selectionBox);
        const hits:PickHit[]=[];
        for(const rec of recordsRef.current) {
          if(rec.meshes.some(mesh=>meshIntersectsVolume(mesh,box))) hits.push({objectId:rec.id,name:rec.name,materialName:rec.materialName,point:box.getCenter(new THREE.Vector3()).toArray() as [number,number,number],coverage:null,role:'object'});
        }
        const volume:SelectionVolume={kind:'axis_aligned_box',coordinateSystem:'gltf_y_up',min:box.min.toArray() as [number,number,number],max:box.max.toArray() as [number,number,number]};
        callbacks.current.onVolume(hits,volume);
        volumePlaced=false;selectionBox.visible=false;helper.visible=false;transformer.enabled=false;
        callbacks.current.onVolumeState(false,false);
      },
    };

    scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8a7360, 1.15));
    const key = new THREE.DirectionalLight(0xfff4e4, 2.1);
    key.position.set(2.6, 4.4, 2.4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd5e2f2, 0.85);
    fill.position.set(-2.4, 2.2, 1.6);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffe0b8, 0.45);
    rim.position.set(-1.2, 2.4, -2.6);
    scene.add(rim);

    let disposed = false;
    let bvhWorker: GenerateMeshBVHWorker | null = null;
    const loadAbort = new AbortController();
    let temporaryUrl: string | null = null;
    const loadPreview = (url: string, liveSnapshot: boolean) => new GLTFLoader().load(url, (gltf) => {
      if (temporaryUrl) { URL.revokeObjectURL(temporaryUrl); temporaryUrl = null; }
      if (disposed) { disposePreview(gltf.scene); return; }
      scene.add(gltf.scene);
      const records = new Map<string, Rec>();
      const defs = gltf.parser.json.nodes || [];
      const previewMetadata = gltf.parser.json.asset?.extras?.point_edit_3d;
      const candidateScene = previewMetadata?.scene_uid;
      const sceneUid = typeof candidateScene === 'string' && /^[a-f0-9]{32}$/.test(candidateScene) ? candidateScene : null;
      const uidCounts = new Map<string, number>();
      for (const def of defs) { const uid = def.extras?.point_edit_3d_uid; if (typeof uid === 'string') uidCounts.set(uid, (uidCounts.get(uid) ?? 0) + 1); }
      gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object instanceof LineSegments2) return;
        let owner: THREE.Object3D | null = object;
        let nodeIndex: number | undefined;
        while (owner && nodeIndex === undefined) {
          const association = gltf.parser.associations.get(owner);
          if (association && association.nodes !== undefined) nodeIndex = association.nodes;
          else owner = owner.parent;
        }
        if (nodeIndex === undefined || !owner) return;
        // 导出器生成的实例/网格副本只用于显示，不作为独立可选对象。
        if (defs[nodeIndex]?.extras?.point_edit_3d_skip === true) return;
        const name = defs[nodeIndex]?.name || `Node ${nodeIndex}`;
        const candidateUid = defs[nodeIndex]?.extras?.point_edit_3d_uid;
        const id = sceneUid && typeof candidateUid === 'string' && /^[a-f0-9]{32}$/.test(candidateUid) && uidCounts.get(candidateUid) === 1 ? candidateUid : `node:${nodeIndex}:${name}`;
        let rec = records.get(id);
        if (!rec) {
          rec = {id, name, materialName:'', root:owner as THREE.Group, meshes:[], outlines:[], basePos:owner.position.clone(), baseScale:owner.scale.clone(), baseMats:[]};
          owner.userData.uid=id; owner.userData.name=name; records.set(id,rec);
        }
        object.userData.uid=id; object.userData.name=name;
        if (Array.isArray(object.material)) object.material=object.material.map(m=>m.clone()); else object.material=object.material.clone();
        // EdgesGeometry builds a hash entry for every mesh edge.  Very large
        // realized procedural meshes can exceed JS object limits before the
        // scene becomes selectable, so use their local bounding box instead.
        const positionCount = object.geometry.getAttribute('position')?.count ?? 0;
        let edgeGeometry: THREE.EdgesGeometry;
        if (positionCount > 300_000) {
          object.geometry.computeBoundingBox();
          const bounds = object.geometry.boundingBox!;
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const box = new THREE.BoxGeometry(size.x, size.y, size.z);
          box.translate(center.x, center.y, center.z);
          edgeGeometry = new THREE.EdgesGeometry(box);
          box.dispose();
        } else {
          edgeGeometry = new THREE.EdgesGeometry(object.geometry, 28);
        }
        const thickGeometry = new LineSegmentsGeometry().fromEdgesGeometry(edgeGeometry);
        edgeGeometry.dispose();
        const lineMaterial = new LineMaterial({ color: intentRef.current === "edit" ? 0x9e7bff : 0x3b82f6, linewidth: 3.5, toneMapped: false });
        lineMaterial.resolution.set(host.clientWidth, host.clientHeight);
        const edges = new LineSegments2(thickGeometry, lineMaterial);
        edges.raycast=()=>{}; edges.visible=false; object.add(edges); rec.meshes.push(object); rec.outlines.push(edges);
      });
      recordsRef.current=[...records.values()];
      recordsRef.current.forEach(seal);
      pickablesRef.current=recordsRef.current.flatMap(rec=>rec.meshes);
      // Build one static-mesh index at a time off the UI thread. Indirect mode
      // preserves triangle ordering and the source geometry used by annotations.
      const candidates = [...new Set(pickablesRef.current.filter(mesh =>
        !((mesh as THREE.SkinnedMesh).isSkinnedMesh) && !mesh.morphTargetInfluences?.length &&
        (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) >= 3000
      ).map(mesh => mesh.geometry))];
      if (candidates.length && typeof Worker !== 'undefined') {
        try {
          bvhWorker = new GenerateMeshBVHWorker();
          const worker = bvhWorker;
          void (async () => {
            for (const geometry of candidates) {
              if (disposed) break;
              try {
                const tree = await worker.generate(geometry, {indirect:true});
                if (disposed) break;
                geometry.boundsTree = tree;
                for (const mesh of pickablesRef.current) if (mesh.geometry === geometry && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && !mesh.morphTargetInfluences?.length) mesh.raycast = acceleratedRaycast;
                window.dispatchEvent(new CustomEvent('point-edit-ray-index', {detail:{status:'ready', triangles:(geometry.index?.count ?? geometry.getAttribute('position').count)/3}}));
              } catch (error) { if (!disposed) console.warn('空间索引不可用，使用原始射线计算', error); }
            }
            if (!disposed) { worker.dispose(); if (bvhWorker === worker) bvhWorker = null; }
          })();
        } catch (error) { console.warn('空间索引不可用，使用原始射线计算', error); }
      }
      CATALOG.splice(0,CATALOG.length,...recordsRef.current.map(rec=>({id:rec.id,name:rec.name,material:rec.materialName,collection:'GLB 快照'})));
      window.dispatchEvent(new CustomEvent('point-edit-scene-loaded', {detail:{sceneUid, liveSnapshot, compatibility:previewMetadata?.preview_compatibility, uids:recordsRef.current.map(rec => rec.id).filter(id => /^[a-f0-9]{32}$/.test(id)), allStable:recordsRef.current.every(rec => /^[a-f0-9]{32}$/.test(rec.id))}}));
      const bounds=new THREE.Box3().setFromObject(gltf.scene);
      if (!bounds.isEmpty()) { const center=bounds.getCenter(new THREE.Vector3()), size=bounds.getSize(new THREE.Vector3()); const distance=Math.max(size.x,size.y,size.z,1)*3.0; bounds.getBoundingSphere(sceneSphere); controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(distance,distance*.7,distance));controls.update(); }
    },undefined,(error)=>{console.error('Point Edit 3D 预览初始化失败:', error); if (temporaryUrl) { URL.revokeObjectURL(temporaryUrl); temporaryUrl = null; } if (!disposed) window.dispatchEvent(new CustomEvent('point-edit-scene-error',{detail:`无法解析 ${isC4d ? 'C4D' : 'Blender'} 预览模型`}))});
    void (async () => {
      try {
        const response = await fetch('/__point_edit_3d/current-scene', {method:'POST', headers:{'x-point-edit-scene': isC4d ? 'c4d' : 'blender'}, signal:loadAbort.signal});
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(typeof body.error === 'string' ? body.error.replace(/^Error: /, '') : `无法读取 ${isC4d ? 'C4D' : 'Blender'} 预览`);
        }
        const snapshot = await response.blob();
        if (disposed) return;
        temporaryUrl = URL.createObjectURL(snapshot);
        loadPreview(temporaryUrl, true);
      } catch (error) {
        if (!disposed) window.dispatchEvent(new CustomEvent('point-edit-scene-error',{detail:error instanceof Error ? error.message : `无法读取 ${isC4d ? 'C4D' : 'Blender'} 预览`}));
      }
    })();

    const raycaster = rayRef.current;
    raycaster.firstHitOnly = true;
    let frame = 0;

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      for (const rec of recordsRef.current) for (const line of rec.outlines) line.material.resolution.set(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const loop = () => {
      frame = requestAnimationFrame(loop);
      controls.update();
      const clip = clippingPlanes(camera.position.distanceTo(controls.target), camera.position.distanceTo(sceneSphere.center), sceneSphere.radius, viewSettingsRef.current.nearFactor);
      if (Math.abs(camera.near - clip.near) > 1e-6 || Math.abs(camera.far - clip.far) > 1e-3 || camera.fov !== viewSettingsRef.current.fov) {
        camera.fov = viewSettingsRef.current.fov;
        camera.near = clip.near; camera.far = clip.far; camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    };
    loop();

    const ndcFromEvent = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
    };

    const cast = (ndc: THREE.Vector2) => {
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickablesRef.current, false);
      return hits[0] ?? null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || toolRef.current === 'look') return;
      if (toolRef.current === 'volume' && volumePlaced) return;
      dragRef.current = { x: event.clientX, y: event.clientY, active: toolRef.current === "box" };
      if (toolRef.current === "box" && boxRef.current) {
        const bounds = host.getBoundingClientRect();
        boxRef.current.style.display = "block";
        boxRef.current.style.left = `${event.clientX - bounds.left}px`;
        boxRef.current.style.top = `${event.clientY - bounds.top}px`;
        boxRef.current.style.width = "0px";
        boxRef.current.style.height = "0px";
      }
      renderer.domElement.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active || !boxRef.current) return;
      const bounds = host.getBoundingClientRect();
      const left = Math.min(drag.x, event.clientX) - bounds.left;
      const top = Math.min(drag.y, event.clientY) - bounds.top;
      const width = Math.abs(event.clientX - drag.x);
      const height = Math.abs(event.clientY - drag.y);
      boxRef.current.style.left = `${left}px`;
      boxRef.current.style.top = `${top}px`;
      boxRef.current.style.width = `${width}px`;
      boxRef.current.style.height = `${height}px`;
    };

    const hideBox = () => {
      if (boxRef.current) boxRef.current.style.display = "none";
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      hideBox();

      if (toolRef.current==='look') return;

      if (toolRef.current === 'volume') {
        if (moved > 8) return;
        const found=cast(ndcFromEvent(event));
        if (!found) return;
        const side=1; // Fixed world-space default; users can resize after placing it.
        selectionBox.position.copy(found.point); selectionBox.scale.setScalar(side); selectionBox.visible=true;
        initialPosition.copy(selectionBox.position); initialScale.copy(selectionBox.scale);
        volumePlaced=true; helper.visible=true; transformer.enabled=true;
        callbacks.current.onVolumeState(true,true); return;
      }

      if (toolRef.current === "frame") {
        callbacks.current.onFrame();
        return;
      }

      if (toolRef.current === "box" && moved > 8) {
        const bounds = host.getBoundingClientRect();
        const left = Math.min(drag.x, event.clientX);
        const right = Math.max(drag.x, event.clientX);
        const top = Math.min(drag.y, event.clientY);
        const bottom = Math.max(drag.y, event.clientY);
        let step = 12;
        while (((right - left) / step) * ((bottom - top) / step) > 1600) step += 6;
        const counts = new Map<string, { hit: PickHit; samples: NonNullable<PickHit["samples"]> }>();
        const rays: RaySample[] = [];
        let samples = 0;
        for (let y = top + step / 2; y < bottom; y += step) {
          for (let x = left + step / 2; x < right; x += step) {
            samples += 1;
            const ndc = new THREE.Vector2(
              ((x - bounds.left) / bounds.width) * 2 - 1,
              -((y - bounds.top) / bounds.height) * 2 + 1,
            );
            const found = cast(ndc);
            const screen: [number, number] = [(x - bounds.left) / bounds.width, (y - bounds.top) / bounds.height];
            if (!found) { rays.push({ screen, objectId: null, depth: null, point: null }); continue; }
            const picked = hitFromMesh(found.object, found.point, null);
            if (!picked) { rays.push({ screen, objectId: null, depth: null, point: null }); continue; }
            const prev = counts.get(picked.objectId);
            const sample = { screen, depth: -found.point.clone().applyMatrix4(camera.matrixWorldInverse).z, point: found.point.toArray() as [number, number, number] };
            rays.push({ ...sample, objectId: picked.objectId });
            if (prev) prev.samples.push(sample);
            else counts.set(picked.objectId, { hit: picked, samples: [sample] });
          }
        }
        const rawHits = [...counts.values()]
          .map(({ hit, samples: hitSamples }) => ({
            ...hit,
            coverage: samples ? hitSamples.length / samples : 0,
            samples: hitSamples,
            totalSamples: samples,
            depth: hitSamples.reduce((sum, sample) => sum + sample.depth, 0) / hitSamples.length,
            ...(() => {
              const rec = recordsRef.current.find(item => item.id === hit.objectId)!;
              const box = new THREE.Box3();
              for (const mesh of rec.meshes) box.union(new THREE.Box3().setFromObject(mesh));
              const depths: number[] = [];
              for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
                depths.push(-new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z);
              return { depthMin: Math.min(...depths), depthMax: Math.max(...depths) };
            })(),
          }))
          .sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0));
        const hits: PickHit[] = classifyBox(rawHits);
        if (hits.length) hits[0].rays = rays;
        if (hits.length === 0) callbacks.current.onEmpty();
        else callbacks.current.onPick(hits, hits[0] ?? null);
        return;
      }

      const found = cast(ndcFromEvent(event));
      if (!found) {
        callbacks.current.onEmpty();
        return;
      }
      const picked = hitFromMesh(found.object, found.point, null);
      if (!picked) {
        callbacks.current.onEmpty();
        return;
      }
      callbacks.current.onPick([picked], picked);
    };

    // OrbitControls scales pan and wheel movement by the distance to its pivot.
    // After zooming through that pivot it can shrink to millimetres while the
    // visible scene is far away; re-anchor in front of the camera without
    // moving it or changing its viewing direction.
    const navigationRay = new THREE.Raycaster();
    navigationRay.firstHitOnly = true;
    const navigationForward = new THREE.Vector3();
    const navigationOffset = new THREE.Vector3();
    const recoverNavigation = (event: PointerEvent | WheelEvent) => {
      if (!controls.enabled || transformer.dragging) return;
      const currentDistance = camera.position.distanceTo(controls.target);
      if (currentDistance >= pivotRecoveryThreshold(sceneSphere.radius)) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      camera.updateMatrixWorld();
      camera.getWorldDirection(navigationForward);
      const point = new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
      navigationRay.setFromCamera(point, camera);
      const hit = navigationRay.intersectObjects(pickablesRef.current, false)[0];
      const depth = hit ? navigationOffset.copy(hit.point).sub(camera.position).dot(navigationForward) : null;
      const recovered = recoveredPivotDistance(currentDistance, depth, sceneSphere.radius);
      if (recovered === null) return;
      controls.target.copy(camera.position).addScaledVector(navigationForward, recovered);
      controls.update();
    };
    const recoverOnPointer = (event: PointerEvent) => { if (event.button === 2) recoverNavigation(event); };
    renderer.domElement.addEventListener('pointerdown', recoverOnPointer, true);
    renderer.domElement.addEventListener('wheel', recoverNavigation, {capture:true,passive:true});

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    return () => {
      disposed = true;
      bvhWorker?.dispose(); bvhWorker = null;
      loadAbort.abort();
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', recoverOnPointer, true);
      renderer.domElement.removeEventListener('wheel', recoverNavigation, true);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      transformer.dispose(); volumeActions.current=null; volumeAppearance.current=null;
      controlsRef.current = null;
      if (import.meta.env.DEV) delete (window as Window & {__pointEditTesting?:unknown}).__pointEditTesting;
      disposePreview(scene);
      undoStack.length = 0;
      renderer.dispose();
      renderer.domElement.remove();
      recordsRef.current = [];
      pickablesRef.current = [];
      CATALOG.splice(0, CATALOG.length);
    };
  }, []);

  return (
    <div ref={hostRef} className="relative h-full min-h-80 w-full overflow-hidden bg-bg">
      <div ref={slotRef} className="absolute inset-0" />
      <div ref={boxRef} className={`pointer-events-none absolute z-10 hidden border-2 ${intent === "edit" ? "border-edit bg-edit/15" : "border-ask bg-ask/15"}`} />
    </div>
  );
});

const undoStack: UndoFrame[] = [];

function pushUndo(rec: Rec) {
  undoStack.push({
    id: rec.id,
    pos: [rec.root.position.x, rec.root.position.y, rec.root.position.z],
    scale: [rec.root.scale.x, rec.root.scale.y, rec.root.scale.z],
    mats: rec.meshes.map((mesh) => snapMat(mesh.material as THREE.Material)),
  });
  if (undoStack.length > 30) undoStack.shift();
}
