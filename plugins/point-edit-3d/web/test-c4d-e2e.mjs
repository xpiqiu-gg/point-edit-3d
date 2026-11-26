// C4D 端到端检查（独立测试场景，不碰用户正在编辑的文档）：
// 连接 → 预览 → 点选/框选/三维框 → 提交 → 执行 → 撤销 → 异常场景。
// 运行：node test-c4d-e2e.mjs ../server.bundle.cjs
// 需要 C4D 正在运行并已加载 C4D MCP 插件（默认 127.0.0.1:5555）。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { c4dCommand, gltfNodeWorldMatrices, gltfSceneBounds } from './scene-c4d.mjs';

const PORT = Number(process.env.POINT_EDIT_3D_C4D_PORT || 5555);
const bundle = path.resolve(process.argv[2] || '../server.bundle.cjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'point-edit-c4d-e2e-'));
const dataDirectory = path.join(temp, 'inbox');
const c4dDirectory = path.join(temp, 'c4d');
const baseEnv = { ...process.env, POINT_EDIT_3D_DATA_DIR: dataDirectory, POINT_EDIT_3D_BACKUP_DIR: path.join(temp, 'backups') };
const step = (message) => console.log(`[c4d-e2e] ${message}`);
const bounded = async (work, ms = 10000) => {
  try { await Promise.race([work(), new Promise((resolve) => setTimeout(resolve, ms))]); } catch { /* 关闭失败不影响结论 */ }
};
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`[c4d-e2e] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------------------ */
/* 直接驱动 C4D（仅测试用）                                            */
/* ------------------------------------------------------------------ */
async function python(script, timeoutSeconds = 90) {
  const response = await c4dCommand({ command: 'execute_python', script, timeout_seconds: timeoutSeconds }, { port: PORT, timeoutMs: (timeoutSeconds + 20) * 1000 });
  return typeof response.output === 'string' ? response.output : '';
}
function lastJson(output, marker) {
  const index = output.lastIndexOf(marker);
  if (index < 0) throw new Error(`没有找到 ${marker}：${output.slice(-500)}`);
  return JSON.parse(output.slice(index + marker.length).split('\n')[0].trim());
}
async function activeDocument() {
  const output = await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nprint('PE3D:' + json.dumps({'name': doc.GetDocumentName() if doc else None, 'objects': len(doc.GetObjects()) if doc else 0}))");
  return lastJson(output, 'PE3D:');
}
async function listDocuments() {
  const output = await python("import c4d, json\nnames = []\nd = c4d.documents.GetFirstDocument()\nwhile d is not None:\n    names.append(d.GetDocumentName())\n    d = d.GetNext()\nprint('PE3D:' + json.dumps(names))");
  return lastJson(output, 'PE3D:');
}
async function activateDocument(name) {
  const script = `import c4d, json\ntarget = None\nd = c4d.documents.GetFirstDocument()\nwhile d is not None:\n    if d.GetDocumentName() == ${JSON.stringify(name)}:\n        target = d\n        break\n    d = d.GetNext()\nif target is None:\n    print('PE3D:' + json.dumps({'ok': False, 'error': 'not found'}))\nelse:\n    c4d.documents.SetActiveDocument(target)\n    c4d.EventAdd()\n    print('PE3D:' + json.dumps({'ok': True, 'name': target.GetDocumentName()}))`;
  const output = await python(script);
  const value = lastJson(output, 'PE3D:');
  if (!value.ok) throw new Error(`无法激活文档 ${name}`);
  return value;
}
async function killDocument(name) {
  const script = `import c4d, json\ntarget = None\nd = c4d.documents.GetFirstDocument()\nwhile d is not None:\n    if d.GetDocumentName() == ${JSON.stringify(name)}:\n        target = d\n        break\n    d = d.GetNext()\nif target is None:\n    print('PE3D:' + json.dumps({'ok': True, 'missing': True}))\nelse:\n    active = c4d.documents.GetActiveDocument()\n    if active is target:\n        print('PE3D:' + json.dumps({'ok': False, 'error': 'document is active'}))\n    else:\n        c4d.documents.KillDocument(target)\n        print('PE3D:' + json.dumps({'ok': True}))`;
  const output = await python(script);
  const value = lastJson(output, 'PE3D:');
  if (!value.ok) throw new Error(`无法关闭文档 ${name}：${value.error}`);
  return value;
}
async function killAllDocuments(name) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const value = await killDocument(name);
    if (value.missing) return;
  }
}
async function renameDocument(name, nextName) {
  const script = `import c4d, json\ntarget = None\nd = c4d.documents.GetFirstDocument()\nwhile d is not None:\n    if d.GetDocumentName() == ${JSON.stringify(name)}:\n        target = d\n        break\n    d = d.GetNext()\nif target is None:\n    print('PE3D:' + json.dumps({'ok': False, 'error': 'not found'}))\nelse:\n    try:\n        target.SetDocumentName(${JSON.stringify(nextName)})\n    except Exception:\n        pass\n    print('PE3D:' + json.dumps({'ok': True, 'name': target.GetDocumentName()}))`;
  const output = await python(script);
  const value = lastJson(output, 'PE3D:');
  if (!value.ok) throw new Error(`无法重命名文档 ${name}`);
  return value.name;
}
const PY_HELPERS = `import c4d, json, os, time

def _mat(doc, name, color):
    for material in doc.GetMaterials():
        if material.GetName() == name:
            material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(*color)
            return material
    material = c4d.BaseMaterial(c4d.Mmaterial)
    material.SetName(name)
    material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(*color)
    doc.InsertMaterial(material)
    return material

def _assign(obj, material):
    tag = obj.MakeTag(c4d.Ttexture)
    tag[c4d.TEXTURETAG_MATERIAL] = material
    return tag

def _cube(doc, name, pos, size, parent=None):
    obj = c4d.BaseObject(c4d.Ocube)
    obj.SetName(name)
    obj[c4d.PRIM_CUBE_LEN] = c4d.Vector(size, size, size)
    obj.SetAbsPos(c4d.Vector(*pos))
    if parent is not None:
        obj.InsertUnder(parent)
    else:
        doc.InsertObject(obj)
    return obj

def _report(doc, extra=None):
    info = {'name': doc.GetDocumentName(), 'objects': len(doc.GetObjects()), 'materials': [m.GetName() for m in doc.GetMaterials()]}
    if extra:
        info.update(extra)
    print('PE3D_DOC:' + json.dumps(info))
`;
const created = [];
async function createDocument(name, body) {
  const uniqueName = `${name}-${created.length + 1}`;
  const script = `${PY_HELPERS}
doc = c4d.documents.BaseDocument()
try:
    doc.SetDocumentName(${JSON.stringify(uniqueName)})
except Exception:
    pass
${body}
c4d.documents.InsertBaseDocument(doc)
c4d.documents.SetActiveDocument(doc)
c4d.EventAdd()
_report(doc)`;
  const output = await python(script, 120);
  const info = lastJson(output, 'PE3D_DOC:');
  created.push(info.name);
  return info;
}
const scenes = {
  cube: () => createDocument('PE3D_TestCube', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
cube = _cube(doc, 'Cube', (0, 0, 0), 100)
_assign(cube, material)`),
  multi: () => createDocument('PE3D_TestMulti', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
cube = _cube(doc, 'Cube', (0, 0, 0), 80)
_assign(cube, material)
_cube(doc, 'Dup', (-260, 0, 0), 60)
_cube(doc, 'Dup', (260, 0, 0), 60)
group = c4d.BaseObject(c4d.Onull)
group.SetName('Group')
group.SetAbsPos(c4d.Vector(0, 260, 0))
doc.InsertObject(group)
_cube(doc, 'Child', (0, 60, 0), 60, group)
instance = c4d.BaseObject(c4d.Oinstance)
instance.SetName('CubeInstance')
instance[c4d.INSTANCEOBJECT_LINK] = cube
instance.SetAbsPos(c4d.Vector(0, -260, 0))
doc.InsertObject(instance)
camera = c4d.BaseObject(c4d.Ocamera)
camera.SetName('TestCamera')
camera.SetAbsPos(c4d.Vector(0, 120, -600))
doc.InsertObject(camera)
hidden = _cube(doc, 'HiddenCube', (0, -420, 0), 60)
hidden.SetEditorMode(c4d.MODE_OFF)`),
  box: () => createDocument('PE3D_TestBox', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
big = _cube(doc, 'BigCube', (0, 0, 0), 300)
_assign(big, material)
small = _cube(doc, 'SmallCube', (0, 250, 0), 80)
_assign(small, material)
plane = c4d.BaseObject(c4d.Oplane)
plane.SetName('BackPlane')
plane[c4d.PRIM_PLANE_WIDTH] = 900
plane[c4d.PRIM_PLANE_HEIGHT] = 900
plane.SetAbsPos(c4d.Vector(0, 0, 300))
plane.SetAbsRot(c4d.Vector(c4d.utils.Rad(-90), 0, 0))
doc.InsertObject(plane)`),
  error: () => createDocument('PE3D_TestError', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
doomed = _cube(doc, 'Doomed', (0, 0, 0), 100)
_assign(doomed, material)`),
  undo: () => createDocument('PE3D_TestUndo', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
cube = _cube(doc, 'UndoCube', (0, 0, 0), 100)
_assign(cube, material)
_cube(doc, 'Extra', (300, 0, 0), 80)
_cube(doc, 'Extra2', (-300, 0, 0), 80)`),
  pivot: () => createDocument('PE3D_TestPivot', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
parent = c4d.BaseObject(c4d.Onull)
parent.SetName('PivotParent')
parent.SetAbsPos(c4d.Vector(100, 200, 300))
parent.SetAbsRot(c4d.Vector(c4d.utils.Rad(30), 0, c4d.utils.Rad(20)))
parent.SetAbsScale(c4d.Vector(1.5, 1.5, 1.5))
doc.InsertObject(parent)
corners = [(-25,-25,-25),(25,-25,-25),(25,25,-25),(-25,25,-25),(-25,-25,25),(25,-25,25),(25,25,25),(-25,25,25)]
points = [c4d.Vector(x + 100, y, z) for (x, y, z) in corners]
poly = c4d.PolygonObject(8, 6)
poly.SetAllPoints(points)
for index, quad in enumerate([(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]):
    poly.SetPolygon(index, c4d.CPolygon(*quad))
poly.Message(c4d.MSG_UPDATE)
poly.SetName('OffsetPoly')
poly.SetAbsPos(c4d.Vector(0, 0, 200))
poly.SetAbsRot(c4d.Vector(0, c4d.utils.Rad(45), 0))
poly.SetAbsScale(c4d.Vector(2, 1, 1))
poly.InsertUnder(parent)
_assign(poly, material)`),
  empty: () => createDocument('PE3D_TestEmpty', `pass`),
};

/* ------------------------------------------------------------------ */
/* 预览坐标/屏幕投影                                                    */
/* ------------------------------------------------------------------ */
async function fetchPreview(origin) {
  const response = await fetch(`${origin}/__point_edit_3d/current-scene`, { method: 'POST', headers: { 'x-point-edit-scene': 'c4d', Origin: origin } });
  const text = await response.text();
  assert.equal(response.status, 200, `预览读取失败：${text.slice(0, 300)}`);
  return JSON.parse(text);
}
function cameraFor(bounds) {
  const distance = Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1) * 3;
  return { center: bounds.center, eye: [bounds.center[0] + distance, bounds.center[1] + distance * 0.7, bounds.center[2] + distance], distance };
}
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a) { const length = Math.hypot(...a) || 1; return a.map(value => value / length); }
function project(point, camera, width, height, fovDegrees = 42) {
  const forward = normalize(subtract(camera.center, camera.eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const relative = subtract(point, camera.eye);
  const z = dot(relative, forward);
  const tan = Math.tan((fovDegrees * Math.PI) / 180 / 2);
  const ndcX = (dot(relative, right) / z) / (tan * (width / height));
  const ndcY = (dot(relative, up) / z) / tan;
  return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height };
}
function objectPositions(preview, manifest) {
  const matrices = gltfNodeWorldMatrices(preview);
  const positions = new Map();
  for (const object of manifest.objects || []) {
    const matrix = matrices.get(object.nodeIndex);
    if (!matrix) continue;
    positions.set(object.uid, { name: object.name, point: [matrix[12], matrix[13], matrix[14]], object });
  }
  return positions;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env: { ...baseEnv, POINT_EDIT_3D_C4D_PORT: String(PORT) } });
const client = new Client({ name: 'point-edit-c4d-e2e', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
let browser;
let failure = null;
const original = await activeDocument();
step(`原始文档：${original.name}（${original.objects} 个对象）`);
try {
  const session = await call('point_edit_3d_open', { scene: 'c4d' });
  record('连接 C4D 与预览会话', session.c4dConnected === true, session.c4dError || `文档 ${session.c4dScene?.document?.name}`);
  assert.equal(session.c4dConnected, true);
  const origin = new URL(session.url).origin;

  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  const fatal = [];
  const pageErrors = [];
  page.on('pageerror', (error) => fatal.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/swiftshader|WebGL|GPU stall|favicon|Failed to load resource/i.test(text)) return;
    pageErrors.push(text);
  });
  page.on('crash', () => fatal.push('页面崩溃'));

  async function openScene(key) {
    const info = await scenes[key]();
    await page.goto(session.url);
    await page.getByText(/已读取 C4D 当前场景/).first().waitFor({ timeout: 150000 });
    await page.getByText(/C4D 已连接 · \d+ 个编号已匹配/).first().waitFor({ timeout: 60000 });
    const preview = await fetchPreview(origin);
    const bounds = gltfSceneBounds(preview);
    assert.ok(bounds, '预览没有网格边界');
    const scene = await call('point_edit_3d_c4d_scene', {});
    assert.equal(scene.ok, true, JSON.stringify(scene));
    const manifest = JSON.parse(await readFile(path.join(c4dDirectory, `${scene.result.sceneUid}.json`), 'utf8'));
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    const camera = cameraFor(bounds);
    const positions = objectPositions(preview, manifest);
    step(`${info.name} / ${manifest.objects.length} 个对象 / 精度 ${manifest.transform?.accuracy || 'none'}`);
    return { info, scene: scene.result, manifest, canvas, box, camera, positions, preview };
  }
  function screenOf(context, uid) {
    const entry = context.positions.get(uid);
    assert.ok(entry, `找不到对象位置：${uid}`);
    return project(entry.point, context.camera, context.box.width, context.box.height);
  }
  const clickObject = async (context, uid) => {
    const point = screenOf(context, uid);
    await context.canvas.click({ position: point });
    await page.waitForTimeout(150);
  };
  const chipFor = (name) => page.locator('aside section').first().getByRole('button', { name: new RegExp(name) });
  async function saveAnnotation({ intent, text }) {
    await page.getByRole('button', { name: intent === 'edit' ? '编辑' : '询问', exact: true }).click();
    await page.locator('aside textarea').first().fill(text);
    await page.getByRole('button', { name: '记下这条批注' }).click();
    await page.getByText(/批注已提交/).first().waitFor({ timeout: 30000 });
  }
  async function latestSnapshot() {
    const read = await call('point_edit_3d_read', { sessionId: session.sessionId });
    assert.equal(read.status, 'submitted', '没有读到提交');
    return read.snapshot;
  }

  /* ---------------- 立方体：点选 → 改色 → 撤销 ---------------- */
  const cubeScene = await openScene('cube');
  const cubeUid = [...cubeScene.positions.entries()].find(([, value]) => value.name === 'Cube')?.[0];
  assert.ok(cubeUid, '场景里没有 Cube');
  await clickObject(cubeScene, cubeUid);
  await chipFor('Cube').waitFor();
  await saveAnnotation({ intent: 'edit', text: '把这个立方体改成红色，只改材质颜色。' });
  let snapshot = await latestSnapshot();
  let note = snapshot.annotations[0];
  record('点选并提交编辑批注', note.identity === 'c4d_object' && note.targets.some(target => target.objectId === cubeUid), note.text);
  assert.equal(note.identity, 'c4d_object');
  const cubeTarget = note.targets.find(target => target.role !== 'surface');
  assert.equal(cubeTarget.objectId, cubeUid);
  assert.equal(cubeTarget.c4d?.name, 'Cube');
  assert.ok(cubeTarget.c4dPoint && Array.isArray(cubeTarget.c4dPoint.value), '缺少换算后的 C4D 落点');
  const redCode = `material = None
for candidate in doc.GetMaterials():
    if candidate.GetName() == 'PE3D_Base':
        material = candidate
        break
if material is None:
    material = c4d.BaseMaterial(c4d.Mmaterial)
    material.SetName('PE3D_Base')
    doc.InsertMaterial(material)
material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(1.0, 0.0, 0.0)
emit({'material': material.GetName()})`;
  const executed = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: snapshot.submissionId, annotationId: note.id, targetUids: [cubeUid], code: redCode });
  record('执行改色（建立撤销组）', executed.ok === true && executed.result.executed === true && executed.result.undo?.group === true, JSON.stringify(executed.result?.undo));
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.ok(executed.result.backup && (await stat(executed.result.backup)).size > 0, '缺少恢复副本');
  const colourAfter = lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nmat = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Base'][0]\nc = mat[c4d.MATERIAL_COLOR_COLOR]\nprint('PE3D:' + json.dumps([c.x, c.y, c.z]))"), 'PE3D:');
  record('改色生效', colourAfter[0] === 1 && colourAfter[1] === 0, JSON.stringify(colourAfter));
  assert.ok(colourAfter[0] === 1 && colourAfter[1] === 0);
  await python("import c4d\ndoc = c4d.documents.GetActiveDocument()\nok = doc.DoUndo()\nc4d.EventAdd()\nprint('PE3D:' + str(ok))");
  const colourUndone = lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nmat = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Base'][0]\nc = mat[c4d.MATERIAL_COLOR_COLOR]\nprint('PE3D:' + json.dumps([c.x, c.y, c.z]))"), 'PE3D:');
  record('Ctrl+Z 撤销改色', colourUndone[0] === 0 && colourUndone[2] === 1, JSON.stringify(colourUndone));
  assert.ok(colourUndone[0] === 0 && colourUndone[2] === 1);

  /* ---------------- 执行失败：真实错误 + 恢复副本 ---------------- */
  const failing = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: snapshot.submissionId, annotationId: note.id, targetUids: [cubeUid], code: 'raise RuntimeError("故意失败")' });
  record('执行失败如实返回并保留恢复副本', failing.ok === false && failing.result.failed === true && /故意失败/.test(failing.result.error || '') && !!failing.result.backup && failing.result.undo?.group === true, JSON.stringify({ failed: failing.result?.failed, backup: !!failing.result?.backup, undo: failing.result?.undo?.group }));
  assert.equal(failing.ok, false);
  assert.equal(failing.result.failed, true);
  assert.ok(failing.result.backup && (await stat(failing.result.backup)).size > 0);

  /* ---------------- 询问批注不执行 ---------------- */
  await clickObject(cubeScene, cubeUid);
  await saveAnnotation({ intent: 'question', text: '这个立方体的比例合适吗？' });
  snapshot = await latestSnapshot();
  const question = snapshot.annotations[0];
  const questionExec = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: snapshot.submissionId, annotationId: question.id, targetUids: [cubeUid], code: 'emit({})' });
  record('询问批注拒绝执行', questionExec.ok === false && /编辑批注/.test(questionExec.error || ''), questionExec.error);
  assert.equal(questionExec.ok, false);

  /* ---------------- 外部目标拒绝 ---------------- */
  await clickObject(cubeScene, cubeUid);
  await saveAnnotation({ intent: 'edit', text: '再把这个立方体改成红色。' });
  snapshot = await latestSnapshot();
  const editNote = snapshot.annotations[0];
  const foreign = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: snapshot.submissionId, annotationId: editNote.id, targetUids: ['0'.repeat(32)], code: 'emit({})' });
  record('拒绝批注之外的物体', foreign.ok === false && /纳入的对象/.test(foreign.error || ''), foreign.error);
  assert.equal(foreign.ok, false);

  /* ---------------- 撤销：新增 / 修改 / 删除 / 多步 ---------------- */
  const undoScene = await openScene('undo');
  const undoCubeUid = [...undoScene.positions.entries()].find(([, value]) => value.name === 'UndoCube')?.[0];
  assert.ok(undoCubeUid, '撤销场景缺少 UndoCube');
  await clickObject(undoScene, undoCubeUid);
  await saveAnnotation({ intent: 'edit', text: '撤销测试：新增材质、改色、删除对象。' });
  const undoSnapshot = await latestSnapshot();
  const undoNote = undoSnapshot.annotations[0];
  const runUndoCode = (code) => call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: undoSnapshot.submissionId, annotationId: undoNote.id, targetUids: [undoCubeUid], code });
  const c4dUndo = () => python("import c4d\ndoc = c4d.documents.GetActiveDocument()\nok = doc.DoUndo()\nc4d.EventAdd()\nprint('PE3D:' + str(ok))");
  const sceneNames = async () => lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\ncube = doc.SearchObject('UndoCube')\nprint('PE3D:' + json.dumps({'objects': [o.GetName() for o in doc.GetObjects()], 'materials': [m.GetName() for m in doc.GetMaterials()], 'tags': len(cube.GetTags()) if cube else -1}))"), 'PE3D:');
  const baseColour = async () => lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nmaterial = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Base'][0]\nc = material[c4d.MATERIAL_COLOR_COLOR]\nprint('PE3D:' + json.dumps([round(c.x, 3), round(c.y, 3), round(c.z, 3)]))"), 'PE3D:');

  const addMaterial = await runUndoCode(`material = c4d.BaseMaterial(c4d.Mmaterial)
material.SetName('PE3D_UndoAdded')
material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(0.0, 0.0, 1.0)
doc.InsertMaterial(material)
tag = target.MakeTag(c4d.Ttexture)
tag[c4d.TEXTURETAG_MATERIAL] = material
emit({})`);
  record('新增材质建立撤销记录', addMaterial.ok === true && addMaterial.result.undo?.deleteUndo?.registered === true, JSON.stringify(addMaterial.result?.undo?.deleteUndo));
  const afterAdd = await sceneNames();
  await c4dUndo();
  const afterAddUndo = await sceneNames();
  record('撤销新增材质与标签', afterAdd.materials.includes('PE3D_UndoAdded') && !afterAddUndo.materials.includes('PE3D_UndoAdded') && afterAddUndo.tags === 1, JSON.stringify({ afterAdd, afterAddUndo }));

  const changeColour = await runUndoCode("material = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Base'][0]\nmaterial[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(0.0, 1.0, 0.0)\nemit({})");
  const green = await baseColour();
  await c4dUndo();
  const blue = await baseColour();
  record('撤销材质颜色修改', changeColour.ok === true && green[1] === 1 && blue[2] === 1, JSON.stringify({ green, blue }));

  const deleteExtra = await runUndoCode("obj = doc.SearchObject('Extra')\nif obj is not None:\n    obj.Remove()\nemit({})");
  const afterDelete = await sceneNames();
  await c4dUndo();
  const afterDeleteUndo = await sceneNames();
  record('删除非目标对象并撤销恢复', deleteExtra.ok === true && deleteExtra.result.undo?.deleteUndo?.registered === true && deleteExtra.result.undo?.deletedObjects === true && !afterDelete.objects.includes('Extra') && afterDeleteUndo.objects.includes('Extra'), JSON.stringify({ deleteUndo: deleteExtra.result?.undo?.deleteUndo, afterDelete: afterDelete.objects, afterUndo: afterDeleteUndo.objects }));

  const stepA = await runUndoCode("material = c4d.BaseMaterial(c4d.Mmaterial)\nmaterial.SetName('PE3D_Step')\nmaterial[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(0.0, 0.0, 1.0)\ndoc.InsertMaterial(material)\ntag = target.MakeTag(c4d.Ttexture)\ntag[c4d.TEXTURETAG_MATERIAL] = material\nemit({})");
  const stepB = await runUndoCode("material = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Step'][0]\nmaterial[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(1.0, 0.0, 0.0)\nemit({})");
  const stepC = await runUndoCode("obj = doc.SearchObject('Extra2')\nif obj is not None:\n    obj.Remove()\nemit({})");
  const stepState = await lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nmaterial = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Step'][0]\nc = material[c4d.MATERIAL_COLOR_COLOR]\nprint('PE3D:' + json.dumps({'objects': [o.GetName() for o in doc.GetObjects()], 'stepColor': [round(c.x, 3), round(c.y, 3), round(c.z, 3)]}))"), 'PE3D:');
  await c4dUndo();
  const undoStep1 = await lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nprint('PE3D:' + json.dumps({'objects': [o.GetName() for o in doc.GetObjects()]}))"), 'PE3D:');
  await c4dUndo();
  const undoStep2 = await lastJson(await python("import c4d, json\ndoc = c4d.documents.GetActiveDocument()\nmaterial = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Step'][0]\nc = material[c4d.MATERIAL_COLOR_COLOR]\nprint('PE3D:' + json.dumps({'color': [round(c.x, 3), round(c.y, 3), round(c.z, 3)]}))"), 'PE3D:');
  await c4dUndo();
  const undoStep3 = await sceneNames();
  record('多步操作按逆序撤销', stepA.ok && stepB.ok && stepC.ok && !stepState.objects.includes('Extra2') && stepState.stepColor[0] === 1 && undoStep1.objects.includes('Extra2') && undoStep2.color[2] === 1 && !undoStep3.materials.includes('PE3D_Step'), JSON.stringify({ stepState, undoStep1, undoStep2, undoStep3 }));

  const deleteTarget = await runUndoCode('target.Remove()\nemit({})');
  const afterTargetDelete = await sceneNames();
  await c4dUndo();
  const afterTargetUndo = await sceneNames();
  record('删除目标对象并撤销恢复', deleteTarget.ok === true && !afterTargetDelete.objects.includes('UndoCube') && afterTargetUndo.objects.includes('UndoCube'), JSON.stringify({ afterTargetDelete: afterTargetDelete.objects, afterTargetUndo: afterTargetUndo.objects }));
  const backupOpened = lastJson(await python(`import c4d, json
path = ${JSON.stringify(deleteTarget.result.backup)}
loaded = c4d.documents.LoadDocument(path, c4d.SCENEFILTER_OBJECTS | c4d.SCENEFILTER_MATERIALS, None)
ok = loaded is not None
objects = [o.GetName() for o in loaded.GetObjects()] if loaded else []
materials = [m.GetName() for m in loaded.GetMaterials()] if loaded else []
if loaded:
    c4d.documents.KillDocument(loaded)
print('PE3D:' + json.dumps({'ok': ok, 'objects': objects, 'materials': materials}))`), 'PE3D:');
  record('恢复副本可以打开', backupOpened.ok === true && backupOpened.objects.includes('UndoCube'), JSON.stringify(backupOpened));

  /* ---------------- 多物体、重名、引用 ---------------- */
  const multi = await openScene('multi');
  const byName = (name, index = 0) => [...multi.positions.entries()].filter(([, value]) => value.name === name)[index]?.[0];
  const mainCube = byName('Cube');
  const dupLeft = byName('Dup', 0);
  const dupRight = byName('Dup', 1);
  assert.ok(mainCube && dupLeft && dupRight, '多物体场景缺少对象');
  await clickObject(multi, mainCube);
  await saveAnnotation({ intent: 'question', text: '这个立方体的材质是什么？' });
  const afterFirst = await latestSnapshot();
  const firstNote = afterFirst.annotations[0];
  assert.ok(firstNote.number >= 1 && firstNote.number <= 20, '批注序号超出引用范围');
  const referenceSymbol = String.fromCodePoint(0x2460 + firstNote.number - 1);
  await clickObject(multi, dupLeft);
  await saveAnnotation({ intent: 'edit', text: `参考${referenceSymbol}，把这个 Dup 立方体改成红色。` });
  const multiSnapshot = await latestSnapshot();
  const multiNotes = multiSnapshot.annotations.filter(item => item.sceneUid === multi.scene.sceneUid);
  assert.equal(multiNotes.length, 2, `本场景应有两條批注，实际 ${multiNotes.length}`);
  const second = multiNotes[0];
  const first = multiNotes.find(item => item.number === firstNote.number);
  record('两条批注选区互不串', second.targets.some(target => target.objectId === dupLeft) && !second.targets.some(target => target.objectId === mainCube) && first.targets.some(target => target.objectId === mainCube), `第二条=${second.targets.map(t => t.c4d?.name).join(',')}`);
  const reference = second.references?.find(item => item.number === firstNote.number);
  record('批注引用序号可解析', !!reference && reference.id === first.id, JSON.stringify(second.references));
  const dupTarget = second.targets.find(target => target.objectId === dupLeft);
  const dupCode = `material = None
for candidate in doc.GetMaterials():
    if candidate.GetName() == 'PE3D_Red':
        material = candidate
        break
if material is None:
    material = c4d.BaseMaterial(c4d.Mmaterial)
    material.SetName('PE3D_Red')
    doc.InsertMaterial(material)
material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(1.0, 0.0, 0.0)
tag = target.MakeTag(c4d.Ttexture)
tag[c4d.TEXTURETAG_MATERIAL] = material
emit({'target': target.GetName()})`;
  const dupExec = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: multiSnapshot.submissionId, annotationId: second.id, targetUids: [dupTarget.objectId], code: dupCode });
  record('按引用执行到指定重名对象', dupExec.ok === true && dupExec.result.targets[0]?.uid === dupLeft, JSON.stringify(dupExec.result?.targets?.map(t => t.uid)));
  assert.equal(dupExec.ok, true, JSON.stringify(dupExec));
  assert.equal(dupExec.result.targets[0].uid, dupLeft);
  await python("import c4d\ndoc = c4d.documents.GetActiveDocument()\ndoc.DoUndo()\nc4d.EventAdd()");

  /* ---------------- 二维框选（大物体/小物体/背景表面） ---------------- */
  const boxScene = await openScene('box');
  const bigUid = [...boxScene.positions.entries()].find(([, value]) => value.name === 'BigCube')?.[0];
  const smallUid = [...boxScene.positions.entries()].find(([, value]) => value.name === 'SmallCube')?.[0];
  const backUid = [...boxScene.positions.entries()].find(([, value]) => value.name === 'BackPlane')?.[0];
  assert.ok(bigUid && smallUid && backUid, '框选场景缺少对象');
  const bigPoint = screenOf(boxScene, bigUid), smallPoint = screenOf(boxScene, smallUid);
  const left = Math.min(bigPoint.x, smallPoint.x) - 70;
  const top = Math.min(bigPoint.y, smallPoint.y) - 70;
  const right = Math.max(bigPoint.x, smallPoint.x) + 70;
  const bottom = Math.max(bigPoint.y, smallPoint.y) + 70;
  await page.getByRole('button', { name: /^框选/ }).click();
  await page.mouse.move(boxScene.box.x + left, boxScene.box.y + top);
  await page.mouse.down();
  await page.mouse.move(boxScene.box.x + right, boxScene.box.y + bottom, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await saveAnnotation({ intent: 'question', text: '框选范围内的物体比例和背景关系是否合适？' });
  const boxSnapshot = await latestSnapshot();
  const boxNote = boxSnapshot.annotations[0];
  const roles = new Map(boxNote.targets.map(target => [target.objectId, target]));
  const smallTarget = roles.get(smallUid), bigTarget = roles.get(bigUid), backTarget = roles.get(backUid);
  record('框选保留小物体', !!smallTarget && typeof smallTarget.coverage === 'number' && smallTarget.coverage > 0, JSON.stringify(smallTarget?.coverage));
  record('框选保留全部命中并给出角色', boxNote.targets.length >= 3 && !!bigTarget && bigTarget.role === 'object' && !!backTarget && ['object', 'surface'].includes(backTarget.role), `big=${bigTarget?.role} back=${backTarget?.role} 共 ${boxNote.targets.length} 个`);
  assert.ok(smallTarget && bigTarget && backTarget);
  assert.equal(bigTarget.role, 'object');
  assert.ok(['object', 'surface'].includes(backTarget.role));
  assert.ok(Array.isArray(boxNote.rays) || boxNote.targets.some(target => Array.isArray(target.rays)), '缺少射线采样');

  /* ---------------- 三维框 ---------------- */
  const volumeScene = await openScene('cube');
  const volumeUid = [...volumeScene.positions.entries()].find(([, value]) => value.name === 'Cube')?.[0];
  await page.getByRole('button', { name: /^三维框/ }).click();
  await clickObject(volumeScene, volumeUid);
  await page.getByRole('button', { name: '确认选区' }).click();
  await page.getByLabel('已确认的三维框').waitFor({ timeout: 20000 });
  await saveAnnotation({ intent: 'question', text: '这个空间范围里包含立方体吗？' });
  const volumeSnapshot = await latestSnapshot();
  const volumeNote = volumeSnapshot.annotations[0];
  const region = volumeNote.selectionVolumes?.[0];
  record('三维框保存与换算', !!region && region.volume?.coordinateSystem === 'gltf_y_up' && Array.isArray(region.c4dVolume?.min) && region.c4dVolume.min.every((value, axis) => value <= region.c4dVolume.max[axis]), JSON.stringify(region?.c4dVolume));
  assert.ok(region && region.c4dVolume);
  assert.equal(region.volume.coordinateSystem, 'gltf_y_up');
  assert.ok(volumeNote.targets.some(target => target.objectId === volumeUid), '三维框没有命中立方体');

  const volumeCenter = [0, 1, 2].map(axis => (region.volume.min[axis] + region.volume.max[axis]) / 2);
  const volumeSize = [0, 1, 2].map(axis => region.volume.max[axis] - region.volume.min[axis]);
  const volumeScreen = screenOf(volumeScene, volumeUid);
  const dragVolume = async (deltaPixels) => {
    const camera = volumeScene.camera;
    const distanceToCamera = Math.hypot(volumeCenter[0] - camera.eye[0], volumeCenter[1] - camera.eye[1], volumeCenter[2] - camera.eye[2]);
    const factor = distanceToCamera * Math.min(1.9 * Math.tan((42 * Math.PI) / 180 / 2), 7);
    const handleWorld = [volumeCenter[0] + 0.3 * (factor / 4), volumeCenter[1], volumeCenter[2]];
    const handle = project(handleWorld, camera, volumeScene.box.width, volumeScene.box.height);
    const axis = project([volumeCenter[0] + 0.1, volumeCenter[1], volumeCenter[2]], camera, volumeScene.box.width, volumeScene.box.height);
    const dx = axis.x - volumeScreen.x, dy = axis.y - volumeScreen.y;
    const length = Math.hypot(dx, dy) || 1;
    const start = { x: volumeScene.box.x + handle.x, y: volumeScene.box.y + handle.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + (dx / length) * deltaPixels, start.y + (dy / length) * deltaPixels, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const saveVolume = async (text, { mode, drag, reset } = {}) => {
    await page.getByRole('button', { name: /^三维框/ }).click();
    await volumeScene.canvas.click({ position: volumeScreen });
    await page.waitForTimeout(250);
    if (mode) await page.getByRole('button', { name: mode, exact: true }).click();
    if (drag) await dragVolume(drag);
    if (reset) await page.getByRole('button', { name: '重新放置' }).click();
    await page.getByRole('button', { name: '确认选区' }).click();
    await page.getByLabel('已确认的三维框').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '询问', exact: true }).click();
    await page.locator('aside textarea').first().fill(text);
    await page.getByRole('button', { name: '记下这条批注' }).click();
    await page.getByText(/批注已提交/).first().waitFor({ timeout: 30000 });
    const snapshot = await latestSnapshot();
    return snapshot.annotations[0].selectionVolumes[0].volume;
  };
  const moved = await saveVolume('移动三维框', { drag: 40 });
  const movedCenter = [0, 1, 2].map(axis => (moved.min[axis] + moved.max[axis]) / 2);
  const movedSize = [0, 1, 2].map(axis => moved.max[axis] - moved.min[axis]);
  record('拖动三维框手柄移动选区', Math.abs(movedCenter[0] - volumeCenter[0]) > 0.05 && movedSize.every((value, axis) => Math.abs(value - volumeSize[axis]) < 0.01), JSON.stringify({ shift: movedCenter[0] - volumeCenter[0], size: movedSize }));
  const scaled = await saveVolume('缩放三维框', { mode: '调整尺寸', drag: 40 });
  const scaledSize = [0, 1, 2].map(axis => scaled.max[axis] - scaled.min[axis]);
  record('拖动三维框手柄调整尺寸', scaledSize[0] > volumeSize[0] + 0.3 && Math.abs(scaledSize[1] - volumeSize[1]) < 0.05 && Math.abs(scaledSize[2] - volumeSize[2]) < 0.05, JSON.stringify({ before: volumeSize, after: scaledSize }));
  const reset = await saveVolume('重置三维框', { drag: 40, reset: true });
  const resetDiff = Math.max(...reset.min.map((value, axis) => Math.abs(value - region.volume.min[axis])), ...reset.max.map((value, axis) => Math.abs(value - region.volume.max[axis])));
  record('重新放置恢复初始三维框', resetDiff < 1e-3, JSON.stringify({ diff: resetDiff }));

  /* ---------------- 删除 / 重建对象 ---------------- */
  const errorScene = await openScene('error');
  const doomedUid = [...errorScene.positions.entries()].find(([, value]) => value.name === 'Doomed')?.[0];
  await clickObject(errorScene, doomedUid);
  await saveAnnotation({ intent: 'edit', text: '把这个 Doomed 立方体改成红色。' });
  const errorSnapshot = await latestSnapshot();
  const doomedNote = errorSnapshot.annotations[0];
  await python("import c4d\ndoc = c4d.documents.GetActiveDocument()\ntarget = doc.GetFirstObject()\nif target is not None:\n    target.Remove()\nc4d.EventAdd()");
  const missingExec = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: errorSnapshot.submissionId, annotationId: doomedNote.id, targetUids: [doomedUid], code: 'emit({})' });
  record('删除对象后拒绝执行', missingExec.ok === false && /不存在/.test(missingExec.error || ''), missingExec.error);
  assert.equal(missingExec.ok, false);
  await python("import c4d\ndoc = c4d.documents.GetActiveDocument()\nobj = c4d.BaseObject(c4d.Ocube)\nobj.SetName('Doomed')\nobj[c4d.PRIM_CUBE_LEN] = c4d.Vector(100, 100, 100)\nobj.SetAbsPos(c4d.Vector(0, 0, 0))\ndoc.InsertObject(obj)\nmaterial = [m for m in doc.GetMaterials() if m.GetName() == 'PE3D_Base'][0]\ntag = obj.MakeTag(c4d.Ttexture)\ntag[c4d.TEXTURETAG_MATERIAL] = material\nc4d.EventAdd()");
  const rebuiltExec = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: errorSnapshot.submissionId, annotationId: doomedNote.id, targetUids: [doomedUid], code: "emit({'rebuilt': True})" });
  record('重建后按签名重新核验（不静默）', rebuiltExec.ok === true && Array.isArray(rebuiltExec.result.warnings) && rebuiltExec.result.warnings.some(text => /重新核验/.test(text)), JSON.stringify(rebuiltExec.result?.warnings));
  assert.equal(rebuiltExec.ok, true, JSON.stringify(rebuiltExec));

  /* ---------------- 切换文档后旧批注失效 ---------------- */
  const emptyInfo = await scenes.empty();
  await activateDocument(emptyInfo.name);
  const verify = await call('point_edit_3d_verify', { source: 'c4d', sceneUid: doomedNote.sceneUid, uids: [doomedUid] });
  record('切换文档后场景核验为不匹配', verify.ok === true && verify.result.scene_matches === false, JSON.stringify(verify.result?.document));
  const switchedExec = await call('point_edit_3d_execute', { sessionId: session.sessionId, submissionId: errorSnapshot.submissionId, annotationId: doomedNote.id, targetUids: [doomedUid], code: 'emit({})' });
  record('切换文档后拒绝执行', switchedExec.ok === false && /文档已变化/.test(switchedExec.error || ''), switchedExec.error);
  assert.equal(switchedExec.ok, false);

  /* ---------------- 空场景导出失败 ---------------- */
  const emptyPreview = await fetch(`${origin}/__point_edit_3d/current-scene`, { method: 'POST', headers: { 'x-point-edit-scene': 'c4d', Origin: origin } });
  const emptyBody = await emptyPreview.json().catch(() => ({}));
  record('空场景导出给出明确错误', emptyPreview.status === 503 && /没有对象/.test(emptyBody.error || ''), emptyBody.error);
  assert.equal(emptyPreview.status, 503);
  await page.goto(session.url);
  await page.getByText(/没有对象|无法读取 C4D 场景/).first().waitFor({ timeout: 60000 });

  /* ---------------- 轴心偏移/旋转/缩放/父级的包围盒 ---------------- */
  const pivotInfo = await scenes.pivot();
  step(`轴心偏移场景：${pivotInfo.name}`);
  await page.goto(session.url);
  await page.getByText(/已读取 C4D 当前场景/).first().waitFor({ timeout: 150000 });
  await page.getByText(/C4D 已连接 · \d+ 个编号已匹配/).first().waitFor({ timeout: 60000 });
  const pivotScene = await call('point_edit_3d_c4d_scene', {});
  const pivotObject = (pivotScene.result.objects || []).find(object => object.name === 'OffsetPoly');
  const pivotTruth = lastJson(await python(`import c4d, json
doc = c4d.documents.GetActiveDocument()
target = None
stack = [doc.GetFirstObject()]
while stack:
    op = stack.pop()
    while op is not None:
        if op.GetName() == 'OffsetPoly':
            target = op
        stack.append(op.GetDown())
        op = op.GetNext()
mg = target.GetMg()
pts = [mg * point for point in target.GetAllPoints()]
xs = [point.x for point in pts]
ys = [point.y for point in pts]
zs = [point.z for point in pts]
print('PE3D:' + json.dumps({'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]}))`), 'PE3D:');
  const bboxClose = pivotObject && ['min', 'max'].every(key => [0, 1, 2].every(axis => Math.abs(pivotObject.bbox[key][axis] - pivotTruth[key][axis]) < 0.5));
  record('包围盒包含轴心偏移/旋转/缩放/父级', !!bboxClose, JSON.stringify({ tool: pivotObject?.bbox, truth: pivotTruth }));
  assert.ok(bboxClose);
  const previewPivot = await fetchPreview(origin);
  const pivotBounds = gltfSceneBounds(previewPivot);
  const pivotManifest = JSON.parse(await readFile(path.join(c4dDirectory, `${pivotScene.result.sceneUid}.json`), 'utf8'));
  const pivotCanvas = page.locator('canvas');
  const pivotBox = await pivotCanvas.boundingBox();
  const pivotCamera = cameraFor(pivotBounds);
  const pivotPositions = objectPositions(previewPivot, pivotManifest);
  const pivotUid = [...pivotPositions.entries()].find(([, value]) => value.name === 'OffsetPoly')?.[0];
  assert.ok(pivotUid, '预览里没有 OffsetPoly');
  // 该对象的轴心与几何中心不重合，按几何中心（而不是节点原点）点击。
  const pivotCenterC4D = [0, 1, 2].map(axis => (pivotTruth.min[axis] + pivotTruth.max[axis]) / 2);
  const pivotTransform = pivotManifest.transform;
  const pivotCenterGltf = [0, 1, 2].map(axis => pivotTransform.scale * pivotTransform.signs[axis] * pivotCenterC4D[pivotTransform.permutation[axis]]);
  const pivotPoint = project(pivotCenterGltf, pivotCamera, pivotBox.width, pivotBox.height);
  await pivotCanvas.click({ position: pivotPoint });
  await page.waitForTimeout(200);
  await page.locator('aside section').first().getByRole('button', { name: /OffsetPoly/ }).waitFor({ timeout: 15000 });
  await saveAnnotation({ intent: 'question', text: '这个偏移对象的范围是否正确？' });
  const pivotSnapshot = await latestSnapshot();
  const pivotTarget = pivotSnapshot.annotations[0].targets.find(target => target.objectId === pivotUid);
  record('偏移对象批注包围盒一致', !!pivotTarget && ['min', 'max'].every(key => [0, 1, 2].every(axis => Math.abs(pivotTarget.c4d.bbox[key][axis] - pivotTruth[key][axis]) < 0.5)), JSON.stringify(pivotTarget?.c4d?.bbox));
  assert.ok(pivotTarget);

  /* ---------------- 同名未保存文档区分 ---------------- */
  const sameA = await createDocument('PE3D_SameName', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
cube = _cube(doc, 'SameA', (0, 0, 0), 100)
_assign(cube, material)`);
  await renameDocument(sameA.name, 'PE3D_SameName');
  const summaryA = await call('point_edit_3d_c4d_scene', {});
  const sameB = await createDocument('PE3D_SameName', `material = _mat(doc, 'PE3D_Base', (0.0, 0.0, 1.0))
cube = _cube(doc, 'SameB', (0, 0, 0), 100)
_assign(cube, material)`);
  await renameDocument(sameB.name, 'PE3D_SameName');
  const summaryB = await call('point_edit_3d_c4d_scene', {});
  record('同名未保存文档场景编号不同', summaryA.result.document.name === 'PE3D_SameName' && summaryB.result.document.name === 'PE3D_SameName' && summaryA.result.sceneUid !== summaryB.result.sceneUid, `${summaryA.result.sceneUid.slice(0, 8)} / ${summaryB.result.sceneUid.slice(0, 8)}`);
  const uidA = (summaryA.result.objects || []).find(object => object.name === 'SameA')?.uid;
  assert.ok(uidA, '同名场景 A 里没有 SameA');
  const verifyOther = await call('point_edit_3d_verify', { source: 'c4d', sceneUid: summaryA.result.sceneUid, uids: [uidA] });
  record('同名其它文档不会匹配旧批注', verifyOther.ok === true && verifyOther.result.scene_matches === false, JSON.stringify(verifyOther.result?.document));
  const verifyOwn = await call('point_edit_3d_verify', { source: 'c4d', sceneUid: summaryB.result.sceneUid, uids: [(summaryB.result.objects || []).find(object => object.name === 'SameB')?.uid] });
  record('当前同名文档自身可核验', verifyOwn.ok === true && verifyOwn.result.scene_matches === true);

  /* ---------------- 未连接 C4D ---------------- */
  const offlineTemp = await mkdtemp(path.join(os.tmpdir(), 'point-edit-c4d-offline-'));
  const offlineTransport = new StdioClientTransport({ command: process.execPath, args: [bundle], env: { ...baseEnv, POINT_EDIT_3D_DATA_DIR: path.join(offlineTemp, 'inbox'), POINT_EDIT_3D_C4D_PORT: '5999' } });
  const offlineClient = new Client({ name: 'point-edit-c4d-offline', version: '1' });
  await offlineClient.connect(offlineTransport);
  try {
    const offlineCall = async (name, args = {}) => JSON.parse((await offlineClient.callTool({ name, arguments: args })).content[0].text);
    const offline = await offlineCall('point_edit_3d_open', { scene: 'c4d' });
    record('未连接时 open 返回原因', offline.c4dConnected === false && /无法连接 C4D/.test(offline.c4dError || '') && !!offline.c4dSetupHint, offline.c4dError);
    const offlinePage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await offlinePage.setDefaultTimeout(30000);
    await offlinePage.goto(offline.url);
    await offlinePage.getByText(/无法连接 C4D/).first().waitFor({ timeout: 60000 });
    await offlinePage.getByText('预览未载入').first().waitFor({ timeout: 30000 });
    record('未连接时页面显示原因', true);
    await offlinePage.close();
    const setup = await offlineCall('point_edit_3d_c4d_setup', { install: false });
    record('C4D 安装诊断可读', setup.ok === true && setup.result.connected === false && !!setup.result.bundledSource, JSON.stringify(setup.result?.locations));
  } finally {
    await bounded(() => offlineClient.close());
    await rm(offlineTemp, { recursive: true, force: true });
  }

  assert.deepEqual(fatal, [], `页面异常：${fatal.join(' | ')}`);
  assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join(' | ')}`);
  record('页面无异常', true);
} catch (error) {
  failure = error;
  console.error('[c4d-e2e] 失败：', error?.stack || error);
  record('测试中断', false, error?.message || String(error));
} finally {
  try {
    const active = await activeDocument();
    if (active.name !== original.name) {
      const documents = await listDocuments();
      if (documents.includes(original.name)) await activateDocument(original.name);
    }
    for (const name of [...new Set([...created, 'PE3D_SameName'])]) {
      try { await killAllDocuments(name); } catch (cleanupError) { console.error(`[c4d-e2e] 清理 ${name} 失败：`, cleanupError.message); }
    }
    const restored = await activeDocument();
    console.log(`[c4d-e2e] 恢复后活动文档：${restored.name}（${restored.objects} 个对象）`);
  } catch (cleanupError) {
    console.error('[c4d-e2e] 清理异常：', cleanupError?.message || cleanupError);
  }
  if (browser) await bounded(() => browser.close());
  await bounded(() => client.close());
  await bounded(() => rm(temp, { recursive: true, force: true }));
}
const passed = results.filter(item => item.ok).length;
const failed = results.filter(item => !item.ok).length;
console.log(`[c4d-e2e] 结果：${passed} 通过 / ${failed} 失败`);
await new Promise((resolve) => setTimeout(resolve, 200));
process.exit(failure || failed ? 1 : 0);
