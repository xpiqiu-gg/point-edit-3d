// 受控的真实安装/加载验证（C4D 先停止，安装后再启动）：
// 1) 临时 MAXON 目录：setup install=true 创建文件
// 2) 真实用户插件目录：移走文件后 setup install=true 创建文件
// 3) 启动 C4D（C4D_MCP_AUTOSTART=1），验证 5555、场景读取、预览导出
// 4) 重建此前丢失的临时测试场景（红色立方体）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, rename, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { c4dCommand, c4dExportPreview, c4dSceneSummary } from './scene-c4d.mjs';

const execFileAsync = promisify(execFile);
const bundle = path.resolve('../server.bundle.cjs');
const C4D_EXE = 'D:\\Program Files\\Cinema4D\\Cinema 4D.exe';
const pluginDir = path.join(process.env.APPDATA, 'Maxon', 'Cinema4D_B5B9D2AF', 'plugins');
const files = ['mcp_server_plugin.pyp', 'scene_nodes_patterns.py'];
const temp = await mkdtemp(path.join(os.tmpdir(), 'pe3d-live2-'));
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`[live2] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
async function running() { try { const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Cinema 4D.exe', '/NH']); return /Cinema 4D\.exe/i.test(stdout); } catch { return false; } }
async function kill() { await execFileAsync('taskkill', ['/IM', 'Cinema 4D.exe', '/F']).catch(() => {}); for (let i = 0; i < 40; i += 1) { if (!await running()) return true; await sleep(1000); } return !await running(); }
async function up() { try { await c4dSceneSummary({ port: 5555 }); return true; } catch { return false; } }
async function waitPort(want, ms) { const start = Date.now(); while (Date.now() - start < ms) { if (await up() === want) return Date.now() - start; await sleep(2000); } return -1; }
async function setup(env, install) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env: { ...process.env, ...env } });
  const client = new Client({ name: 'live2', version: '1' });
  await client.connect(transport);
  try {
    const response = await client.callTool({ name: 'point_edit_3d_c4d_setup', arguments: { install } });
    return JSON.parse(response.content[0].text);
  } finally { await client.close(); }
}

const beforeHashes = {};
for (const name of files) beforeHashes[name] = hash(await readFile(path.join(pluginDir, name)));
const pluginBackup = path.join(temp, 'plugin-backup');
await mkdir(pluginBackup, { recursive: true });
for (const name of files) await copyFile(path.join(pluginDir, name), path.join(pluginBackup, name));

try {
  record('停止 C4D', await kill());
  record('端口已关闭', await waitPort(false, 30000) >= 0 || !await up());

  // 1) 临时 MAXON 目录
  const fakeBase = path.join(temp, 'maxon');
  await mkdir(path.join(fakeBase, 'Cinema4D_TEST', 'plugins'), { recursive: true });
  const fakeEnv = { POINT_EDIT_3D_DATA_DIR: path.join(temp, 'inbox-a'), POINT_EDIT_3D_MAXON_DIR: fakeBase };
  const fake = await setup(fakeEnv, true);
  const fakeActions = fake.result?.installed?.files || [];
  record('setup 安装到临时 MAXON 目录', fake.result?.connected === false && fakeActions.length === 3 && fakeActions.every(item => item.action === 'created'), JSON.stringify(fakeActions));

  // 2) 真实目录：移走文件后由 setup 创建
  for (const name of files) await rename(path.join(pluginDir, name), path.join(pluginBackup, `${name}.removed`));
  const realEnv = { POINT_EDIT_3D_DATA_DIR: path.join(temp, 'inbox-b') };
  const real = await setup(realEnv, true);
  const realActions = real.result?.installed?.files || [];
  record('setup 安装到真实用户插件目录', real.result?.connected === false && realActions.length === 3 && realActions.every(item => item.action === 'created'), JSON.stringify(realActions));
  const installedHashes = {};
  for (const name of files) installedHashes[name] = hash(await readFile(path.join(pluginDir, name)));
  record('安装文件与随包一致', files.every(name => installedHashes[name] === beforeHashes[name]), JSON.stringify(installedHashes));

  // 3) 启动并验证加载
  const child = spawn(C4D_EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, C4D_MCP_AUTOSTART: '1' } });
  child.unref();
  const waited = await waitPort(true, 240000);
  record('C4D 启动并加载插件', waited >= 0, `${waited} ms`);
  if (waited < 0) throw new Error('C4D 启动后 5555 仍未监听');
  const summary = await c4dSceneSummary({ port: 5555 });
  record('连接后场景可读', summary.connected === true, `${summary.document?.name} / ${summary.objectCount} 个对象`);

  // 4) 重建临时测试场景（红色立方体）
  const rebuilt = await c4dCommand({ command: 'execute_python', script: `import c4d, json
doc = c4d.documents.GetActiveDocument()
material = None
for item in doc.GetMaterials():
    if item.GetName() == 'PointEdit3D_红色材质':
        material = item
        break
if material is None:
    material = c4d.BaseMaterial(c4d.Mmaterial)
    material.SetName('PointEdit3D_红色材质')
    doc.InsertMaterial(material)
material[c4d.MATERIAL_COLOR_COLOR] = c4d.Vector(1.0, 0.0, 0.0)
cube = None
for item in doc.GetObjects():
    if item.GetName() == 'PointEdit3D_TestCube':
        cube = item
        break
if cube is None:
    cube = c4d.BaseObject(c4d.Ocube)
    cube.SetName('PointEdit3D_TestCube')
    cube[c4d.PRIM_CUBE_LEN] = c4d.Vector(50, 50, 50)
    doc.InsertObject(cube)
tag = cube.MakeTag(c4d.Ttexture)
tag[c4d.TEXTURETAG_MATERIAL] = material
c4d.EventAdd()
print('R:' + json.dumps({'objects': [o.GetName() for o in doc.GetObjects()], 'materials': [m.GetName() for m in doc.GetMaterials()]}))
`, timeout_seconds: 60 }, { port: 5555, timeoutMs: 90000 });
  const rebuiltText = String(rebuilt.output || '');
  console.log('[live2] rebuilt:', rebuiltText.slice(rebuiltText.lastIndexOf('R:')));
  const preview = await c4dExportPreview({ port: 5555 }).catch(error => ({ error: String(error) }));
  record('预览导出可用', !preview.error && preview.manifest?.objects?.length > 0, preview.error || `${preview.manifest?.objects?.length} 个对象`);
} catch (error) {
  record('真实安装验证中断', false, error?.message || String(error));
  console.error(error);
} finally {
  // 确保文件在、C4D 在运行
  for (const name of files) {
    try { await readFile(path.join(pluginDir, name)); } catch { await copyFile(path.join(pluginBackup, name), path.join(pluginDir, name)); }
  }
  if (!await running()) {
    const child = spawn(C4D_EXE, [], { detached: true, stdio: 'ignore', env: { ...process.env, C4D_MCP_AUTOSTART: '1' } });
    child.unref();
    await waitPort(true, 180000);
  }
  const finalHashes = {};
  for (const name of files) finalHashes[name] = hash(await readFile(path.join(pluginDir, name)));
  record('插件文件与原始一致', files.every(name => finalHashes[name] === beforeHashes[name]), JSON.stringify(finalHashes));
  await rm(temp, { recursive: true, force: true });
}
const failed = results.filter(item => !item.ok).length;
console.log(`[live2] ${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
