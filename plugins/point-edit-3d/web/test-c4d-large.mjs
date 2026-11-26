// 大场景：800 个对象下的性能与选择正确性。
// 运行：node test-c4d-large.mjs ../server.bundle.cjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { c4dCommand, c4dExportPreview, gltfNodeWorldMatrices, gltfSceneBounds } from './scene-c4d.mjs';

const PORT = Number(process.env.POINT_EDIT_3D_C4D_PORT || 5555);
const bundle = path.resolve(process.argv[2] || '../server.bundle.cjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'point-edit-c4d-large-'));
const baseEnv = { ...process.env, POINT_EDIT_3D_DATA_DIR: path.join(temp, 'inbox'), POINT_EDIT_3D_BACKUP_DIR: path.join(temp, 'backups'), POINT_EDIT_3D_C4D_PORT: String(PORT) };
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`[large] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const run = async (script, timeoutSeconds = 180) => (await c4dCommand({ command: 'execute_python', script, timeout_seconds: timeoutSeconds }, { port: PORT, timeoutMs: (timeoutSeconds + 20) * 1000 })).output;
const j = (out, marker) => JSON.parse(out.slice(out.lastIndexOf(marker) + marker.length).split('\n')[0].trim());
const bounded = async (work, ms = 10000) => { try { await Promise.race([work(), new Promise(resolve => setTimeout(resolve, ms))]); } catch { /* ignore */ } };

const original = j(await run("import c4d, json\nprint('P:' + json.dumps(c4d.documents.GetActiveDocument().GetDocumentName()))"), 'P:');
const builder = `import c4d, json
doc = c4d.documents.BaseDocument()
doc.SetDocumentName('PE3D_TestLarge')
material = c4d.BaseMaterial(c4d.Mmaterial)
material.SetName('PE3D_Base')
material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(0.0, 0.0, 1.0)
doc.InsertMaterial(material)
def cube(name, x, y, z, size):
    obj = c4d.BaseObject(c4d.Ocube)
    obj.SetName(name)
    obj[c4d.PRIM_CUBE_LEN] = c4d.Vector(size, size, size)
    obj.SetAbsPos(c4d.Vector(x, y, z))
    doc.InsertObject(obj)
    return obj
big = cube('BigCube', 0, 0, 0, 600)
small = cube('SmallCube', 0, 500, 0, 120)
plane = c4d.BaseObject(c4d.Oplane)
plane.SetName('BackPlane')
plane[c4d.PRIM_PLANE_WIDTH] = 1500
plane[c4d.PRIM_PLANE_HEIGHT] = 1500
plane.SetAbsPos(c4d.Vector(0, 0, 500))
plane.SetAbsRot(c4d.Vector(c4d.utils.Rad(-90), 0, 0))
doc.InsertObject(plane)
for row in range(20):
    for column in range(40):
        name = 'Grid_%d_%d' % (row, column)
        cube(name, -1200 + column * 30, row * 30, 0, 20)
for item in ('BigCube', 'SmallCube'):
    tag = doc.SearchObject(item).MakeTag(c4d.Ttexture)
    tag[c4d.TEXTURETAG_MATERIAL] = material
c4d.documents.InsertBaseDocument(doc)
c4d.documents.SetActiveDocument(doc)
c4d.EventAdd()
print('D:' + json.dumps({'name': doc.GetDocumentName(), 'objects': len(doc.GetObjects())}))`;
const created = j(await run(builder), 'D:');
console.log('[large] scene:', created);

const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env: baseEnv });
const client = new Client({ name: 'point-edit-c4d-large', version: '1' });
await client.connect(transport);
let browser;
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
try {
  await new Promise(resolve => setTimeout(resolve, 2000));
  let session = await call('point_edit_3d_open', { scene: 'c4d' });
  if (!session.c4dConnected) {
    console.log('[large] first open failed:', session.c4dError);
    await new Promise(resolve => setTimeout(resolve, 5000));
    session = await call('point_edit_3d_open', { scene: 'c4d' });
  }
  console.log('[large] open:', session.c4dConnected, session.c4dError || '');
  assert.equal(session.c4dConnected, true, session.c4dError);
  const origin = new URL(session.url).origin;

  let started = Date.now();
  let scene = await call('point_edit_3d_c4d_scene', {});
  if (!scene.ok) {
    console.log('[large] scene tool failed:', JSON.stringify(scene).slice(0, 800));
    await new Promise(resolve => setTimeout(resolve, 3000));
    scene = await call('point_edit_3d_c4d_scene', {});
  }
  const sceneMs = Date.now() - started;
  console.log('[large] scene tool:', JSON.stringify(scene).slice(0, 300));
  assert.equal(scene.ok, true, JSON.stringify(scene).slice(0, 300));
  record('800 对象场景读取', scene.result.objects.length >= 800, `${scene.result.objects.length} 个对象，${sceneMs} ms`);

  started = Date.now();
  const exported = await c4dExportPreview({ port: PORT });
  const exportMs = Date.now() - started;
  const previewBytes = JSON.stringify(exported.json).length;
  record('预览导出', exported.manifest.objects.length >= 800, `${exported.manifest.objects.length} 个节点对象，${exportMs} ms，${(previewBytes / 1048576).toFixed(2)} MB`);

  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  started = Date.now();
  await page.goto(session.url);
  await page.getByText(/已读取 C4D 当前场景/).first().waitFor({ timeout: 180000 });
  const loadMs = Date.now() - started;
  started = Date.now();
  await page.getByText(/C4D 已连接 · \d+ 个编号已匹配/).first().waitFor({ timeout: 90000 });
  const identityMs = Date.now() - started;
  record('页面载入与身份核验', true, `载入 ${loadMs} ms，身份 ${identityMs} ms`);
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  const preview = await (await fetch(`${origin}/__point_edit_3d/current-scene`, { method: 'POST', headers: { 'x-point-edit-scene': 'c4d', Origin: origin } })).json();
  const bounds = gltfSceneBounds(preview);
  const distance = Math.max(bounds.size[0], bounds.size[1], bounds.size[2], 1) * 3;
  const camera = { center: bounds.center, eye: [bounds.center[0] + distance, bounds.center[1] + distance * 0.7, bounds.center[2] + distance] };
  const manifest = JSON.parse(await readFile(path.join(temp, 'c4d', `${scene.result.sceneUid}.json`), 'utf8'));
  const matrices = gltfNodeWorldMatrices(preview);
  const positions = new Map();
  for (const object of manifest.objects) {
    const matrix = matrices.get(object.nodeIndex);
    if (matrix) positions.set(object.uid, { name: object.name, point: [matrix[12], matrix[13], matrix[14]] });
  }
  const project = (point) => {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (v) => { const length = Math.hypot(...v) || 1; return v.map(value => value / length); };
    const forward = norm(sub(camera.center, camera.eye));
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const relative = sub(point, camera.eye);
    const z = dot(relative, forward);
    const tan = Math.tan((42 * Math.PI) / 180 / 2);
    return { x: ((dot(relative, right) / z / (tan * (box.width / box.height)) + 1) / 2) * box.width, y: ((1 - dot(relative, up) / z / tan) / 2) * box.height };
  };
  const find = (name) => [...positions.entries()].find(([, value]) => value.name === name);
  const big = find('BigCube'), small = find('SmallCube');
  assert.ok(big && small, '缺少 BigCube/SmallCube');

  // 点选小物体
  const smallPoint = project(small[1].point);
  await canvas.click({ position: smallPoint });
  await page.waitForTimeout(200);
  await page.locator('aside section').first().getByRole('button', { name: /SmallCube/ }).waitFor({ timeout: 15000 });
  started = Date.now();
  await page.getByRole('button', { name: '询问', exact: true }).click();
  await page.locator('aside textarea').first().fill('大场景里的小物体是否被正确选中？');
  await page.getByRole('button', { name: '记下这条批注' }).click();
  await page.getByText(/批注已提交/).first().waitFor({ timeout: 30000 });
  const submitMs = Date.now() - started;
  const read = await call('point_edit_3d_read', { sessionId: session.sessionId });
  const note = read.snapshot.annotations[0];
  const picked = note.targets.find(target => target.objectId === small[0]);
  record('点选小物体', !!picked && picked.c4d?.name === 'SmallCube', `提交 ${submitMs} ms，目标 ${note.targets.map(t => t.c4d?.name).join(',')}`);

  // 框选：大物体 + 小物体 + 背景
  const bigPoint = project(big[1].point);
  const left = Math.min(bigPoint.x, smallPoint.x) - 60;
  const top = Math.min(bigPoint.y, smallPoint.y) - 60;
  const right = Math.max(bigPoint.x, smallPoint.x) + 60;
  const bottom = Math.max(bigPoint.y, smallPoint.y) + 60;
  await page.getByRole('button', { name: /^框选/ }).click();
  await page.mouse.move(box.x + left, box.y + top);
  await page.mouse.down();
  await page.mouse.move(box.x + right, box.y + bottom, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '询问', exact: true }).click();
  await page.locator('aside textarea').first().fill('大场景框选是否保留小物体？');
  await page.getByRole('button', { name: '记下这条批注' }).click();
  await page.getByText(/批注已提交/).first().waitFor({ timeout: 30000 });
  const readBox = await call('point_edit_3d_read', { sessionId: session.sessionId });
  const boxNote = readBox.snapshot.annotations[0];
  const boxSmall = boxNote.targets.find(target => target.objectId === small[0]);
  record('框选保留小物体', !!boxSmall && boxSmall.coverage > 0, `命中 ${boxNote.targets.length} 个；SmallCube 覆盖率 ${boxSmall?.coverage}`);

  // 三维框
  await page.getByRole('button', { name: /^三维框/ }).click();
  await canvas.click({ position: smallPoint });
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '确认选区' }).click();
  await page.getByLabel('已确认的三维框').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '询问', exact: true }).click();
  await page.locator('aside textarea').first().fill('大场景三维框是否可用？');
  await page.getByRole('button', { name: '记下这条批注' }).click();
  await page.getByText(/批注已提交/).first().waitFor({ timeout: 30000 });
  const readVolume = await call('point_edit_3d_read', { sessionId: session.sessionId });
  const volumeRegion = readVolume.snapshot.annotations[0].selectionVolumes?.[0];
  record('大场景三维框', !!volumeRegion && !!volumeRegion.c4dVolume && volumeRegion.c4dVolume.min.every((value, axis) => value < volumeRegion.c4dVolume.max[axis]), JSON.stringify(volumeRegion?.c4dVolume));
  const screenshot = path.join(temp, 'large.png');
  await page.screenshot({ path: screenshot });
  console.log('[large] screenshot:', screenshot);
  console.log('[large] timings:', JSON.stringify({ sceneMs, exportMs, previewMB: +(previewBytes / 1048576).toFixed(2), loadMs, identityMs, submitMs }));
} catch (error) {
  record('大场景测试中断', false, error?.message || String(error));
  console.error(error);
} finally {
  if (browser) await bounded(() => browser.close());
  await bounded(() => client.close());
  try {
    await run(`import c4d, json
orig = None
target = None
d = c4d.documents.GetFirstDocument()
while d is not None:
    if d.GetDocumentName() == ${JSON.stringify(original)}:
        orig = d
    if d.GetDocumentName() == ${JSON.stringify(created.name)}:
        target = d
    d = d.GetNext()
if orig is not None:
    c4d.documents.SetActiveDocument(orig)
if target is not None:
    c4d.documents.KillDocument(target)
print('cleanup')`);
  } catch (error) { console.error('cleanup failed:', error.message); }
  await bounded(() => rm(temp, { recursive: true, force: true }));
}
const failed = results.filter(item => !item.ok).length;
console.log(`[large] ${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
