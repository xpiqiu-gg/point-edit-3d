import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, access, copyFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pointEditBridge, blenderCommand } from './bridge.mjs';
import { c4dExecute, c4dIdentity, c4dObjectInfo, c4dPort, c4dSceneDir, c4dSceneObjects, c4dSceneSummary, installC4dPlugin, loadC4dScene, previewPointToC4d } from './scene-c4d.mjs';

const dist = path.join(__dirname, 'web', 'dist');
const inbox = process.env.POINT_EDIT_3D_DATA_DIR || path.join(os.homedir(), '.point-edit-3d', 'inbox');
const blenderPort = Number(process.env.POINT_EDIT_3D_BLENDER_PORT || 9877);
const backupDirectory = process.env.POINT_EDIT_3D_BACKUP_DIR || path.join(path.dirname(inbox), 'backups');
const mcp = new McpServer({ name: 'point-edit-3d', version: '0.1.0' });
let webServer;
const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const clean = (error) => String(error).replace(/^Error:\s*/, '');
async function serve() {
  if (webServer) return webServer;
  const routes = [];
  pointEditBridge({ directory: inbox, blenderPort }).configureServer({ middlewares: { use(route, handler) { routes.push({ route, handler }); } } });
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const route = routes.find(r => r.route === pathname);
      if (route) return route.handler(req, res);
      if (req.method !== 'GET') return res.writeHead(405).end();
      const file = path.resolve(dist, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
      if (file !== path.join(dist, 'index.html') && !file.startsWith(dist + path.sep)) return res.writeHead(403).end();
      const data = await readFile(file);
      const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.wasm':'application/wasm' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type':mime, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  webServer = server;
  return server;
}
async function snapshots() {
  let names;
  try { names = await readdir(inbox); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const records = [];
  for (const name of names.filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort().reverse()) {
    try { const r = JSON.parse(await readFile(path.join(inbox, name), 'utf8')); if (r.app === 'point-edit-3d' && Array.isArray(r.annotations)) records.push(r); } catch { /* Ignore incomplete or unrelated files. */ }
  }
  return records;
}
/** Attach the C4D-side identity of every annotated object to a stored snapshot. */
async function describeC4d(record) {
  if (record.source?.kind !== 'c4d') return record;
  const scenes = new Map();
  for (const note of record.annotations) {
    const sceneUid = note.sceneUid;
    if (!/^[a-f0-9]{32}$/.test(sceneUid || '')) continue;
    if (!scenes.has(sceneUid)) scenes.set(sceneUid, await loadC4dScene(c4dSceneDir(inbox), sceneUid));
    const scene = scenes.get(sceneUid);
    if (!scene) {
      note.c4dScene = { sceneUid, matched: false, reason: '本机没有该场景的预览映射记录，请重新打开 C4D 预览后再批注' };
      continue;
    }
    const index = new Map((scene.objects || []).map(object => [object.uid, object]));
    const transform = scene.transform || null;
    note.c4dScene = {
      sceneUid,
      matched: true,
      document: scene.document,
      c4dVersion: scene.c4d?.version,
      exportedAt: scene.savedAt,
      warnings: scene.warnings || [],
      transform,
      coordinateAccuracy: transform?.accuracy || null,
    };
    for (const target of note.targets || []) {
      const object = index.get(target.objectId);
      const point = Array.isArray(target.point) && target.point.length === 3 ? previewPointToC4d(target.point, transform) : null;
      if (point) {
        target.c4dPoint = { value: point, accuracy: transform?.accuracy || null };
        if (object?.bbox) {
          const box = object.bbox;
          target.c4dPoint.insideBbox = [0, 1, 2].every(axis => point[axis] >= box.min[axis] && point[axis] <= box.max[axis]);
        }
      }
      if (!object) continue;
      target.c4d = {
        uid: object.uid,
        name: object.name,
        exportName: object.exportName,
        typeName: object.typeName,
        path: object.path,
        guid: object.guid,
        bbox: object.bbox,
        materials: object.materials,
        hidden: object.hidden,
        instanceOf: object.instanceOf,
      };
    }
    if (Array.isArray(note.selectionVolumes) && note.selectionVolumes.length) {
      note.selectionVolumes = note.selectionVolumes.map(region => ({
        ...region,
        c4dVolume: convertVolume(region.volume, transform),
        coordinateAccuracy: transform?.accuracy || null,
      }));
    }
    if (note.selectionVolume) {
      note.selectionVolume = { ...note.selectionVolume, c4dVolume: convertVolume(note.selectionVolume, transform), coordinateAccuracy: transform?.accuracy || null };
    }
  }
  return record;
}
function validateEdit(note, targetUids) {
  if (!note || note.intent !== 'edit') throw new Error('只有编辑批注可以执行修改；询问仅用于分析');
  if (new Set(targetUids).size !== targetUids.length) throw new Error('重复的目标编号');
  const targets = (note.targets || []).filter(t => t.role !== 'surface' && t.included !== false);
  if (targetUids.some(id => !targets.some(t => t.objectId === id)) || (note.scope === 'objects' && targetUids.length === 0)) throw new Error('目标必须来自该批注纳入的对象，落点不能作为整件目标');
  return targets;
}
function bboxMatches(a, b) {
  if (!a || !b || !Array.isArray(a.min) || !Array.isArray(b.min)) return false;
  const centre = (box) => [0, 1, 2].map(axis => (box.min[axis] + box.max[axis]) / 2);
  const left = centre(a), right = centre(b);
  const diagonal = Math.hypot(a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]);
  const tolerance = Math.max(0.5, diagonal * 0.02);
  return left.every((value, axis) => Math.abs(value - right[axis]) <= tolerance);
}
function pathText(path) {
  return (path || []).join(' / ');
}
/** Convert an axis-aligned preview box into C4D world space; null when the mapping is unavailable. */
function convertVolume(volume, transform) {
  if (!volume || !transform || !Array.isArray(volume.min) || !Array.isArray(volume.max)) return null;
  const corners = [];
  for (const x of [volume.min[0], volume.max[0]]) {
    for (const y of [volume.min[1], volume.max[1]]) {
      for (const z of [volume.min[2], volume.max[2]]) {
        const point = previewPointToC4d([x, y, z], transform);
        if (point) corners.push(point);
      }
    }
  }
  if (corners.length !== 8) return null;
  const min = [0, 1, 2].map(axis => Math.min(...corners.map(point => point[axis])));
  const max = [0, 1, 2].map(axis => Math.max(...corners.map(point => point[axis])));
  return { min, max, accuracy: transform.accuracy || 'approx' };
}
function failureText(failures) {
  const lines = failures.map((failure) => {
    if (failure.reason === 'not_found') return `${failure.name || '目标对象'}（${pathText(failure.path)}）在当前 C4D 场景中不存在，可能已被删除或重建`;
    if (failure.reason === 'ambiguous') return `${failure.name || '目标对象'} 有 ${failure.candidates?.length || 2} 个同名同层级的候选，无法唯一确定：${(failure.candidates || []).join(', ')}`;
    if (failure.reason === 'moved_or_replaced') return `${failure.name || '目标对象'} 的位置或尺寸与预览时不一致，可能已被替换或移动`;
    if (failure.reason === 'type_changed') return `${failure.name || '目标对象'} 的对象类型已变化（${failure.expected} → ${failure.actual}）`;
    if (failure.reason === 'missing_manifest') return `缺少该场景的预览映射记录，无法核验目标`;
    return '目标核验失败';
  });
  return `${lines.join('；')}。请重新打开 C4D 预览后再批注。`;
}
/**
 * C4D 的物体编号由当前对象实例派生，撤销、对象重建或场景重载后可能变化。
 * 编号失效时，只在“名称 + 层级路径 + 类型 + 包围盒”都唯一吻合时才重新核验；
 * 不唯一或对不上时明确报错，绝不静默作用到别的物体。
 */
async function resolveC4dTargets(sceneUid, targetUids) {
  const identity = await c4dIdentity({ sceneUid, uids: targetUids, port: c4dPort() });
  const scene = await loadC4dScene(c4dSceneDir(inbox), sceneUid);
  const stored = new Map((scene?.objects || []).map(object => [object.uid, object]));
  const warnings = [];
  const differences = [];
  const failures = [];
  if (!identity.scene_matches) return { identity, scene, uids: targetUids, warnings, differences, failures };
  const byUid = new Map((identity.objects || []).map(item => [item.uid, item]));
  const uids = [...targetUids];
  let liveObjects = null;
  const readLive = async () => {
    if (!liveObjects) liveObjects = await c4dSceneObjects({ port: c4dPort() });
    return liveObjects.objects || [];
  };
  for (let index = 0; index < targetUids.length; index += 1) {
    const uid = targetUids[index];
    const item = byUid.get(uid);
    const entry = stored.get(uid);
    if (item?.resolved) {
      if (!entry) { differences.push(`${item.name} 缺少预览时的记录，无法比较改名或移动`); continue; }
      if (entry.type !== item.type) failures.push({ uid, reason: 'type_changed', name: item.name, expected: entry.typeName, actual: item.typeName });
      if ((entry.name || '') !== (item.name || '')) differences.push(`${entry.name} 在 C4D 中已改名为 ${item.name}`);
      if ((entry.path || []).join('/') !== (item.path || []).join('/')) differences.push(`${item.name} 的层级路径已变化（${pathText(entry.path)} → ${pathText(item.path)}）`);
      if (entry.bbox && item.bbox && !bboxMatches(entry.bbox, item.bbox)) differences.push(`${item.name} 的包围盒与预览时不同（可能被移动或缩放）`);
      continue;
    }
    if (!entry) { failures.push({ uid, reason: 'missing_manifest', name: item?.name || null }); continue; }
    const objects = await readLive();
    const path = (entry.path || []).join('/');
    const candidates = objects.filter(object => object.name === entry.name && (object.path || []).join('/') === path && object.type === entry.type);
    if (!candidates.length) { failures.push({ uid, reason: 'not_found', name: entry.name, path: entry.path }); continue; }
    if (candidates.length > 1) { failures.push({ uid, reason: 'ambiguous', name: entry.name, path: entry.path, candidates: candidates.map(object => object.uid) }); continue; }
    if (!bboxMatches(entry.bbox, candidates[0].bbox)) { failures.push({ uid, reason: 'moved_or_replaced', name: entry.name, path: entry.path }); continue; }
    uids[index] = candidates[0].uid;
    warnings.push(`${entry.name} 的物体编号已变化，已按名称、层级、类型和包围盒唯一重新核验`);
  }
  if (!warnings.length) return { identity, scene, uids: targetUids, warnings, differences, failures };
  const confirmed = await c4dIdentity({ sceneUid, uids, port: c4dPort() });
  if (!confirmed.scene_matches || (confirmed.objects || []).some(item => !item.resolved)) {
    return { identity, scene, uids: targetUids, warnings: [], differences, failures: failures.concat([{ reason: 'missing_manifest', name: null }]) };
  }
  return { identity: confirmed, scene, uids, warnings, differences, failures };
}
async function executeC4d({ note, targetUids, code }) {
  const sceneUid = note.sceneUid;
  if (note.identity !== 'c4d_object') throw new Error('这条批注没有稳定的 C4D 物体对应关系，请在 C4D 预览中重新批注');
  if (!/^[a-f0-9]{32}$/.test(sceneUid || '')) throw new Error('批注缺少 C4D 场景编号，请在 C4D 预览中重新批注');
  const rechecked = await resolveC4dTargets(sceneUid, targetUids);
  if (!rechecked.identity.scene_matches) throw new Error('C4D 当前文档已变化（可能切换、重开或新建了文档），请重新打开预览后再批注');
  if (rechecked.failures.length) throw new Error(failureText(rechecked.failures));
  const uids = rechecked.uids;
  const backupPath = path.join(backupDirectory, `point-edit-c4d-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.c4d`);
  const result = await c4dExecute({ sceneUid, uids, code, backupPath, port: c4dPort() });
  const warnings = [...rechecked.warnings, ...rechecked.differences];
  if (result.undo && result.undo.group === false) warnings.push('C4D 撤销组未能建立，本次修改无法用 Ctrl+Z 撤销（仍保留恢复副本）');
  if (result.undo?.deletedObjects) warnings.push('本次操作删除了对象；已为可登记的对象建立撤销记录，若仍无法撤销可用恢复副本找回');
  if (result.undo?.deleteUndo && result.undo.deleteUndo.registered === false) {
    warnings.push(`场景有 ${result.undo.deleteUndo.skipped} 个对象，超过删除撤销登记上限 ${result.undo.deleteUndo.limit}；未登记删除撤销的对象如果被删除，请用恢复副本找回`);
  }
  if (result.undo?.materialsSkipped) warnings.push(`场景材质超过 ${result.undo.materialsSkipped} 个，未为全部材质建立撤销记录`);
  const scene = rechecked.scene;
  if (scene?.transform) {
    const index = new Map((scene.objects || []).map(object => [object.uid, object]));
    for (const target of (note.targets || []).filter(item => targetUids.includes(item.objectId))) {
      const object = index.get(target.objectId);
      const point = Array.isArray(target.point) && target.point.length === 3 ? previewPointToC4d(target.point, scene.transform) : null;
      if (!object?.bbox || !point) continue;
      const tolerance = 0.05 / scene.transform.scale;
      const inside = [0, 1, 2].every(axis => point[axis] >= object.bbox.min[axis] - tolerance && point[axis] <= object.bbox.max[axis] + tolerance);
      if (!inside) warnings.push(`${object.name} 的批注落点已不在当前包围盒内，物体可能被移动过`);
    }
  }
  return { ...result, warnings, resolvedUids: uids, annotationUids: targetUids, verification: { differences: rechecked.differences } };
}
const execFile = promisify(execFileCallback);
const c4dBridgeFiles = ['mcp_server_plugin.pyp', 'scene_nodes_patterns.py', 'LICENSE'];
async function fileExists(target) {
  try { await access(target); return true; } catch { return false; }
}
async function c4dProcessRunning() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFile('tasklist', ['/FI', 'IMAGENAME eq Cinema 4D.exe', '/NH']);
      return /Cinema 4D\.exe/i.test(stdout);
    } catch { return null; }
  }
  try { await execFile('pgrep', ['-x', 'Cinema 4D']); return true; } catch (error) { return error?.code === 1 ? false : null; }
}
async function c4dPluginDirectories() {
  const override = process.env.POINT_EDIT_3D_MAXON_DIR;
  const base = override
    ? override
    : process.platform === 'win32'
      ? (process.env.APPDATA ? path.join(process.env.APPDATA, 'Maxon') : null)
      : path.join(os.homedir(), 'Library', 'Preferences', 'Maxon');
  if (!base) return [];
  let names = [];
  try { names = await readdir(base); } catch { return []; }
  const found = [];
  for (const name of names.filter(item => /^Cinema4D_[A-Z0-9]+$/i.test(item))) {
    // 目录可能还不存在（用户从未装过插件），安装时会创建。
    found.push(path.join(base, name, 'plugins'));
  }
  return found;
}
async function c4dSetup({ install }) {
  let connected = false, scene = null, connectionError = null;
  try { scene = await c4dSceneSummary({ port: c4dPort() }); connected = true; } catch (error) { connectionError = clean(error); }
  const running = await c4dProcessRunning();
  const directories = await c4dPluginDirectories();
  const locations = [];
  for (const directory of directories) {
    const installed = await fileExists(path.join(directory, 'mcp_server_plugin.pyp'));
    let buildId = null;
    if (installed) buildId = await readFile(path.join(directory, 'mcp_server_plugin.pyp'), 'utf8').then(text => (text.match(/MCP_BUILD_ID\s*=\s*'([^']+)'/) || [])[1] || null).catch(() => null);
    locations.push({ directory, installed, buildId });
  }
  const bundledDirectory = path.join(__dirname, 'c4d_plugin');
  const bundled = await fileExists(path.join(bundledDirectory, 'mcp_server_plugin.pyp'));
  const bundledBuildId = bundled ? await readFile(path.join(bundledDirectory, 'mcp_server_plugin.pyp'), 'utf8').then(text => (text.match(/MCP_BUILD_ID\s*=\s*'([^']+)'/) || [])[1] || null).catch(() => null) : null;
  const result = {
    connected,
    scene: connected ? { sceneUid: scene.sceneUid, document: scene.document, objectCount: scene.objectCount, materialCount: scene.materialCount } : null,
    connectionError,
    c4dRunning: running,
    port: c4dPort(),
    bundledSource: bundled ? bundledDirectory : null,
    bundledBuildId,
    locations,
    installed: null,
    instructions: [],
  };
  if (install && !connected) {
    if (!bundled) throw new Error('当前安装包缺少随包 C4D 插件（c4d_plugin/mcp_server_plugin.pyp）');
    const target = locations.find(item => item.installed)?.directory || locations[0]?.directory;
    if (!target) throw new Error(`找不到 C4D 用户插件目录（${process.platform === 'win32' ? '%APPDATA%\\Maxon\\Cinema4D_*\\plugins' : '~/Library/Preferences/Maxon/Cinema4D_*/plugins'}）。请手动复制 c4d_plugin 中的文件。`);
    const installedResult = await installC4dPlugin({ sourceDirectory: bundledDirectory, targetDirectory: target });
    result.installed = { ...installedResult, restartRequired: true };
    const existing = locations.find(item => item.directory === target);
    if (existing) { existing.installed = true; existing.buildId = bundledBuildId; }
    else locations.push({ directory: target, installed: true, buildId: bundledBuildId });
  }
  result.instructions = connected
    ? ['C4D 已连接，无需安装。']
    : [
        `C4D 进程${running === true ? '正在运行' : running === false ? '未检测到' : '状态未知'}；插件在本机 ${result.port} 端口监听。`,
        locations.length ? `用户插件目录：${locations.map(item => `${item.directory}${item.installed ? '（已安装）' : '（未安装）'}`).join('；')}` : '未检测到 C4D 用户插件目录。',
        bundled ? '随包 C4D 插件可用：调用 point_edit_3d_c4d_setup 并设置 install=true 可复制到用户插件目录。' : '当前安装包缺少随包 C4D 插件。',
        '安装或替换插件后需要重启 Cinema 4D 才会加载。',
        '插件默认不自动启动 socket：请在 C4D 的插件菜单打开 “Socket Server Plugin” 并点击 Start Server，或在启动 C4D 前设置环境变量 C4D_MCP_AUTOSTART=1。',
        '如果 C4D 已安装插件但仍无法连接，请检查是否有防火墙/端口占用，以及 C4D 是否卡在模态对话框。',
      ];
  return result;
}
mcp.registerTool('point_edit_3d_c4d_setup', { title:'检查/安装 C4D 桥接插件', description:'检查 C4D 连接、随包 C4D 插件和用户插件目录；install=true 时把随包插件复制到 C4D 用户插件目录（同名旧文件会备份），之后需要重启 C4D。不修改 C4D 场景。', inputSchema:{install:z.boolean().default(false)} }, async ({install}) => {
  try { return reply({ok:true, result:await c4dSetup({install})}); }
  catch (e) { return reply({ok:false, error:clean(e)}); }
});
mcp.registerTool('point_edit_3d_open', { title:'打开 Point Edit 3D', description:'打开当前 Blender 场景或 C4D 场景进行批注，返回会话 ID 和本地链接。不会写回源文件；C4D 使用场景副本导出预览。', inputSchema:{scene:z.enum(['blender','c4d']).default('blender').describe('选择 Blender 或 C4D')} }, async ({scene}) => {
  const server = await serve();
  const sessionId = randomUUID();
  let blenderConnected = null;
  let c4d = null;
  if (scene === 'blender') { blenderConnected = false; try { await blenderCommand('ping', {}, blenderPort); blenderConnected = true; } catch {} }
  if (scene === 'c4d') { try { c4d = await c4dSceneSummary({ port: c4dPort() }); c4d.connected = true; } catch (error) { c4d = { connected:false, error:clean(error) }; } }
  const connected = scene === 'c4d' ? !!c4d?.connected : null;
  const message = scene === 'c4d' && !connected
    ? `C4D 未连接：${c4d?.error || '未知原因'}。打开链接仍可查看页面提示，但预览和批注需要先连接 C4D。`
    : '打开链接，完成批注并提交，然后回到本次 Codex 对话说继续。';
  return reply({
    sessionId,
    source:scene,
    url:`http://127.0.0.1:${server.address().port}/?session=${sessionId}${scene !== 'blender' ? '&scene=' + scene : ''}`,
    blenderConnected: scene === 'blender' ? blenderConnected : null,
    c4dConnected: connected,
    c4dScene: connected ? { sceneUid:c4d.sceneUid, document:c4d.document, objectCount:c4d.objectCount, materialCount:c4d.materialCount, c4dVersion:c4d.c4dVersion } : null,
    c4dError: scene === 'c4d' && !connected ? c4d?.error : null,
    c4dSetupHint: scene === 'c4d' && !connected ? '可调用 point_edit_3d_c4d_setup 检查随包 C4D 插件并安装到 C4D 用户插件目录（需要重启 C4D）' : null,
    message,
  });
});
mcp.registerTool('point_edit_3d_read', { title:'读取 3D 批注', description:'读取指定会话最近一次完整提交，返回原文、目标、射线、落点和引用；空提交会覆盖旧提交。C4D 批注同时返回对应的 C4D 原物体信息。', inputSchema:{ sessionId:z.string().uuid() } }, async ({sessionId}) => {
  const record = (await snapshots()).find(r => r.sessionId === sessionId);
  if (!record) return reply({ status:'pending', sessionId });
  await describeC4d(record);
  return reply({ status:record.annotations.length ? 'submitted' : 'empty', snapshot:record });
});
mcp.registerTool('point_edit_3d_sessions', { title:'列出 3D 批注会话', description:'列出各会话最近提交的时间和数量，用于恢复本次会话；不要混合不同快照。', inputSchema:{} }, async () => {
  const seen = new Set(), sessions = [];
  for (const r of await snapshots()) if (!seen.has(r.sessionId)) { seen.add(r.sessionId); sessions.push({ sessionId:r.sessionId, receivedAt:r.receivedAt, annotationCount:r.annotations.length, source:r.source?.kind, sceneUid:r.sceneUid, identity:r.identity }); }
  return reply({ sessions });
});
mcp.registerTool('point_edit_3d_verify', { title:'核验 Blender / C4D 物体身份', description:'对照当前 Blender 或 C4D 场景核验稳定场景 UID 和物体 UID，不通过名称猜测。C4D 编号失效时只在名称、层级与包围盒都唯一吻合时才重新核验，并在 warnings 中说明。', inputSchema:{source:z.enum(['blender','c4d']).default('blender'),sceneUid:z.string().regex(/^[a-f0-9]{32}$/), uids:z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(1000)} }, async ({source,sceneUid,uids}) => {
  try {
    if (source === 'c4d') {
      const rechecked = await resolveC4dTargets(sceneUid, uids);
      return reply({ok:true, result:{ ...rechecked.identity, warnings:rechecked.warnings, differences:rechecked.differences, failures:rechecked.failures, resolvedUids:rechecked.uids }});
    }
    return reply({ok:true, result:await blenderCommand('point_edit_3d_identity', {scene_uid:sceneUid,uids}, blenderPort)});
  } catch (e) { return reply({ok:false,error:clean(e)}); }
});
mcp.registerTool('point_edit_3d_object_info', { title:'读取场景对象信息', description:'按稳定 UID 查询当前 Blender 或 C4D 对象的位置、边界和层级。先核验所属场景。', inputSchema:{source:z.enum(['blender','c4d']).default('blender'),sceneUid:z.string().regex(/^[a-f0-9]{32}$/),uid:z.string().regex(/^[a-f0-9]{32}$/)} }, async ({source,sceneUid,uid}) => {
  try {
    if (source === 'c4d') {
      const check = await c4dIdentity({sceneUid, uids:[uid], port:c4dPort()});
      if (!check.scene_matches || !check.objects?.[0]?.resolved) throw new Error('C4D 场景或物体身份已变化');
      return reply({ok:true,result:await c4dObjectInfo({uid, port:c4dPort()})});
    }
    const check=await blenderCommand('point_edit_3d_identity',{scene_uid:sceneUid,uids:[uid]},blenderPort);
    if (!check.scene_matches || !check.objects?.[0]?.resolved) throw new Error('场景或物体身份已变化');
    return reply({ok:true,result:await blenderCommand('point_edit_3d_object_info',{uid},blenderPort)});
  }
  catch(e) { return reply({ok:false,error:clean(e)}); }
});
mcp.registerTool('point_edit_3d_c4d_scene', { title:'读取 C4D 当前场景', description:'读取当前 C4D 文档（不修改）的对象列表：稳定编号、名称、类型、层级、世界位置、包围盒、材质与实例来源，用于把批注对应回原物体。', inputSchema:{limit:z.number().int().min(1).max(5000).default(2000)} }, async ({limit}) => {
  try { return reply({ok:true, result:await c4dSceneObjects({ port:c4dPort(), limit })}); }
  catch (e) { return reply({ok:false, error:clean(e)}); }
});
mcp.registerTool('point_edit_3d_execute', { title:'执行建模批注', description:'仅针对当前会话最新已提交的编辑批注执行 Python：Blender 批注使用 bpy，C4D 批注使用 c4d。选定目标须来自该批注的非落点对象并核验；执行前创建独立恢复副本（.blend 或 .c4d），C4D 还会建立撤销组以便 Ctrl+Z 回退，不保存原文件。Python 可影响其他对象，需遵守原文范围。', inputSchema:{sessionId:z.string().uuid(),submissionId:z.string().uuid(),annotationId:z.string().uuid(),targetUids:z.array(z.string().min(1).max(512)).max(1000),code:z.string().min(1).max(200000)} }, async ({sessionId,submissionId,annotationId,targetUids,code}) => {
  try {
    const record=(await snapshots()).find(r=>r.sessionId===sessionId);
    if (!record || record.submissionId!==submissionId) throw new Error('批注已更新或不存在，请重新读取最新提交');
    const note=record.annotations.find(a=>a.id===annotationId);
    validateEdit(note, targetUids);
    if (record.source?.kind === 'c4d') {
      const result = await executeC4d({ note, targetUids, code });
      return reply({ok:result.executed===true && result.failed!==true, result});
    }
    let sceneUid=note.sceneUid, uids=targetUids;
    const targets=(note.targets||[]).filter(t=>t.role!=='surface' && t.included!==false);
    if (note.identity==='snapshot_only' && record.source?.kind==='blender') {
      const preview=await blenderCommand('point_edit_3d_export_preview',{in_memory:true},blenderPort,90000);
      const glb=Buffer.from(preview.glb_base64 || '', 'base64');
      if (glb.length!==preview.bytes || glb.subarray(0,4).toString('ascii')!=='glTF' || glb.readUInt32LE(16)!==0x4e4f534a) throw new Error('无法读取当前 Blender 场景');
      const doc=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)).toString('utf8'));
      sceneUid=doc.asset?.extras?.point_edit_3d?.scene_uid;
      if (!/^[a-f0-9]{32}$/.test(sceneUid || '')) throw new Error('当前 Blender 场景无法识别');
      uids=[];
      for (const id of targetUids) {
        const target=targets.find(t=>t.objectId===id);
        const matches=(doc.nodes||[]).filter(n=>n.name===target.name && /^[a-f0-9]{32}$/.test(n.extras?.point_edit_3d_uid || ''));
        if (matches.length!==1) throw new Error(`无法唯一对应物体：${target.name}`);
        const uid=matches[0].extras.point_edit_3d_uid;
        if ((doc.nodes||[]).filter(n=>n.extras?.point_edit_3d_uid===uid).length!==1) throw new Error(`物体编号不唯一：${target.name}`);
        if (Array.isArray(target.point) && target.point.length===3 && target.point.every(Number.isFinite)) {
          const info=await blenderCommand('point_edit_3d_object_info',{uid},blenderPort);
          const bounds=info.world_bounds, point=[target.point[0],-target.point[2],target.point[1]];
          if (!bounds || point.some((v,i)=>v<bounds.min[i]-0.02 || v>bounds.max[i]+0.02)) throw new Error(`物体位置已变化：${target.name}`);
        }
        uids.push(uid);
      }
      if (new Set(uids).size!==uids.length) throw new Error('多个目标对应同一物体');
    } else if (note.identity!=='blender_uid' || !/^[a-f0-9]{32}$/.test(sceneUid || '') || targets.some(t=>targetUids.includes(t.objectId) && t.sceneUid!==sceneUid)) throw new Error('无法对应当前 Blender 场景');
    const result=await blenderCommand('point_edit_3d_execute',{scene_uid:sceneUid,uids,code},blenderPort,120000);
    return reply({ok:result.executed===true,result});
  } catch(e) { return reply({ok:false,error:clean(e)}); }
});
mkdir(inbox, { recursive:true }).then(() => mcp.connect(new StdioServerTransport())).catch(error => { console.error(error); process.exitCode = 1; });
