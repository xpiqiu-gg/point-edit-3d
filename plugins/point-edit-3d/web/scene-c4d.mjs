import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile, copyFile } from 'node:fs/promises';

// C4D scene access goes through the socket that the C4D MCP plugin exposes.
// Everything in this module either reads a *clone* of the user's document or
// writes a recovery copy first; the original document is never saved in place.

export const C4D_DEFAULT_PORT = 5555;
const MARKER = 'PE3D_RESULT:';
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function c4dPort(override) {
  const value = Number(override ?? process.env.POINT_EDIT_3D_C4D_PORT ?? C4D_DEFAULT_PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : C4D_DEFAULT_PORT;
}

/** Send one newline-delimited JSON command to the running C4D and await its reply. */
export function c4dCommand(command, options = {}) {
  const port = c4dPort(options.port);
  const timeoutMs = options.timeoutMs ?? 30000;
  const requestId = options.requestId ?? randomUUID();
  const payload = { ...command, request_id: requestId };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error(`C4D 响应超时（${Math.round(timeoutMs / 1000)} 秒）：命令可能仍在 C4D 中执行，请先在 C4D 里确认结果`)));
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('error', (error) => {
      if (settled) return;
      if (error.code === 'ECONNREFUSED') finish(new Error(`无法连接 C4D（127.0.0.1:${port}）。请确认 Cinema 4D 已启动、C4D 插件已加载，并在 C4D 插件菜单打开 “Socket Server Plugin” 点击 Start Server（或启动 C4D 前设置环境变量 C4D_MCP_AUTOSTART=1）；同时检查端口 ${port} 没有被其他程序占用。`));
      else if (error.code === 'ETIMEDOUT') finish(new Error(`连接 C4D 超时（127.0.0.1:${port}）。请确认 C4D 仍在运行且没有弹窗阻塞主线程。`));
      else finish(new Error(`C4D 连接出错：${error.message}`));
    });
    socket.on('close', () => { if (!settled) finish(new Error('C4D 连接已关闭，但没有收到命令结果')); });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_BYTES) return finish(new Error('C4D 回复超过 64 MB 限制'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.request_id && message.request_id !== requestId) continue;
        if (message?.ok === false) return finish(new Error(String(message.error || message.traceback || 'C4D 命令失败')));
        return finish(null, message);
      }
    });
  });
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => (line ? pad + line : '')).join('\n');
}

const PY_BASE = `import c4d, json, os, sys, time, hashlib, traceback, tempfile

def _emit(payload):
    text = json.dumps(payload)
    # C4D 的 execute_python 会截断过长的 stdout（约 64K 字符）。大场景的物体清单/身份
    # 结果改走临时文件，stdout 只留一个引用，避免 JSON 被截断成半截。
    if len(text) > 48000:
        try:
            handle, path = tempfile.mkstemp(prefix='point-edit-3d-', suffix='.json')
            with os.fdopen(handle, 'w', encoding='utf-8') as stream:
                stream.write(text)
            sys.stdout.write('\\n${MARKER}' + json.dumps({'__file__': path, 'ok': True}) + '\\n')
            sys.stdout.flush()
            return
        except Exception:
            pass
    sys.stdout.write('\\n${MARKER}' + text + '\\n')
    sys.stdout.flush()

def _hid(parts):
    return hashlib.sha256(('point-edit-3d:c4d:' + ':'.join([str(p) for p in parts])).encode('utf-8')).hexdigest()[:32]

def _scene_key(doc):
    return (doc.GetDocumentPath() or '').lower() + '/' + (doc.GetDocumentName() or '')

# 同一个 C4D 进程内为每个打开的文档实例分配稳定令牌：同名的未保存文档也能区分；
# 新建、关闭后重建或重新打开文档会得到新令牌，从而让旧批注自动失效而不是误投。
def _scene_token(doc):
    import types
    registry = sys.modules.get('point_edit_3d_registry')
    if registry is None:
        registry = types.ModuleType('point_edit_3d_registry')
        registry.entries = []
        sys.modules['point_edit_3d_registry'] = registry
    name = doc.GetDocumentName() or ''
    path = (doc.GetDocumentPath() or '').lower()
    identity = hash(doc)
    for entry in list(registry.entries):
        try:
            if entry['doc'] == doc and entry['identity'] == identity and entry['name'] == name and entry['path'] == path:
                return entry['token']
        except Exception:
            continue
    token = hashlib.sha256((str(identity) + '|' + path + '/' + name + '|' + str(len(registry.entries)) + '|' + str(time.time())).encode('utf-8')).hexdigest()[:32]
    registry.entries.append({'doc': doc, 'identity': identity, 'name': name, 'path': path, 'token': token})
    if len(registry.entries) > 64:
        del registry.entries[:-64]
    return token

def _scene_uid(doc):
    return _hid(['scene', _scene_token(doc)])

def _document_info(doc):
    return {'name': doc.GetDocumentName() or '', 'path': doc.GetDocumentPath() or '', 'key': _scene_key(doc)}
`;

const PY_COLLECT = `
def _type_name(op):
    try:
        return str(op.GetTypeName())
    except Exception:
        return ''

def _object_path(op):
    names = []
    current = op
    while current is not None:
        names.insert(0, current.GetName() or '')
        current = current.GetUp()
    return names

def _world_bbox(op):
    # 轴心（GetMp）与几何中心可能不一致：必须把轴心偏移一起变换，否则有偏移的
    # 对象会得到以轴心为中心的错误包围盒。GetMp 在不同版本可能是 Vector 或 Matrix。
    try:
        radius = op.GetRad()
        center = op.GetMp()
        matrix = op.GetMg()
    except Exception:
        return None
    if center is None:
        center = c4d.Vector(0.0, 0.0, 0.0)
    if hasattr(center, 'off'):
        center = center.off
    xs = []
    ys = []
    zs = []
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            for sz in (-1.0, 1.0):
                point = matrix * (center + c4d.Vector(sx * radius.x, sy * radius.y, sz * radius.z))
                xs.append(point.x)
                ys.append(point.y)
                zs.append(point.z)
    return {'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]}

def _material_info(doc):
    info = {}
    shader_id = getattr(c4d, 'MATERIAL_COLOR_SHADER', None)
    texture_id = getattr(c4d, 'MATERIAL_COLOR_TEXTURE', None)
    for material in doc.GetMaterials():
        name = material.GetName()
        item = {'type': int(material.GetType()), 'typeName': '', 'hasShader': False, 'standard': int(material.GetType()) == int(c4d.Mmaterial)}
        try:
            item['typeName'] = str(material.GetTypeName())
        except Exception:
            pass
        try:
            if shader_id is not None and material[shader_id] is not None:
                item['hasShader'] = True
            if texture_id is not None and material[texture_id] is not None:
                item['hasShader'] = True
        except Exception:
            pass
        info[name] = item
    return info

def _material_names(op):
    names = []
    tag = op.GetFirstTag()
    while tag is not None:
        try:
            if tag.GetType() == c4d.Ttexture:
                material = tag[c4d.TEXTURETAG_MATERIAL]
                if material is not None:
                    names.append(material.GetName())
        except Exception:
            pass
        tag = tag.GetNext()
    return names

def _editor_hidden(op):
    try:
        return op.GetEditorMode() == c4d.MODE_OFF
    except Exception:
        return False

def _render_hidden(op):
    try:
        return op.GetRenderMode() == c4d.MODE_OFF
    except Exception:
        return False

def _instance_target(op):
    try:
        if op.GetType() == c4d.Oinstance:
            return op[c4d.INSTANCEOBJECT_LINK]
    except Exception:
        return None
    return None

def _collect(op, depth, parent_uid, entries, used):
    while op is not None:
        name = op.GetName() or ''
        base = name or 'Object'
        export_name = base
        if export_name in used:
            index = 2
            while base + ' (' + str(index) + ')' in used:
                index += 1
            export_name = base + ' (' + str(index) + ')'
        used.add(export_name)
        guid = op.GetGUID()
        matrix = op.GetMg()
        instance = _instance_target(op)
        instance_guid = instance.GetGUID() if instance is not None else 0
        entry = {
            'uid': _hid(['object', guid]) if guid else _hid(['object-fallback', len(entries), name, _object_path(op)]),
            'guid': str(guid),
            'stable': bool(guid),
            'name': name,
            'exportName': export_name,
            'type': int(op.GetType()),
            'typeName': _type_name(op),
            'depth': depth,
            'parentUid': parent_uid,
            'path': _object_path(op),
            'world': [matrix.off.x, matrix.off.y, matrix.off.z],
            'bbox': _world_bbox(op),
            'materials': _material_names(op),
            'hidden': _editor_hidden(op),
            'renderHidden': _render_hidden(op),
            'instanceOf': instance.GetName() if instance is not None else None,
            'instanceOfUid': (_hid(['object', instance_guid]) if instance_guid else None),
        }
        entries.append(entry)
        _collect(op.GetDown(), depth + 1, entry['uid'], entries, used)
        op = op.GetNext()

def _collect_scene(doc):
    entries = []
    _collect(doc.GetFirstObject(), 0, None, entries, set())
    return entries

def _flatten(op, out):
    while op is not None:
        out.append(op)
        _flatten(op.GetDown(), out)
        op = op.GetNext()

def _flat_preorder(doc):
    out = []
    _flatten(doc.GetFirstObject(), out)
    return out
`;

function pyScript(body, { collect = false } = {}) {
  return `${PY_BASE}${collect ? PY_COLLECT : ''}
def _main():
${indent(body.trim(), 4)}

try:
    _main()
except Exception:
    _emit({'ok': False, 'error': traceback.format_exc()})
`;
}

async function runPython(body, options = {}) {
  const timeoutSeconds = options.timeoutSeconds ?? 90;
  const response = await c4dCommand(
    { command: 'execute_python', script: body, timeout_seconds: timeoutSeconds },
    { port: options.port, timeoutMs: options.timeoutMs ?? (timeoutSeconds + 20) * 1000 },
  );
  const output = typeof response.output === 'string' ? response.output : '';
  const at = output.lastIndexOf(MARKER);
  if (at < 0) throw new Error(`C4D 没有返回脚本结果${output.trim() ? `：${output.trim().slice(-400)}` : ''}`);
  const line = output.slice(at + MARKER.length).split('\n')[0].trim();
  let payload;
  try { payload = JSON.parse(line); } catch { throw new Error(`C4D 返回了无法解析的结果：${line.slice(0, 200)}`); }
  if (payload && payload.__file__) {
    const filePath = String(payload.__file__);
    try {
      payload = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`C4D 结果文件读取失败（${filePath}）：${error.message}`);
    } finally {
      await unlink(filePath).catch(() => {});
    }
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* glTF helpers                                                        */
/* ------------------------------------------------------------------ */

function parseGltf(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'glTF') {
    const jsonLength = buffer.readUInt32LE(12);
    const jsonType = buffer.readUInt32LE(16);
    if (jsonType !== 0x4e4f534a || jsonLength <= 0 || 20 + jsonLength > buffer.length) throw new Error('C4D 导出的 GLB 结构无效');
    return { json: JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8')), binary: true };
  }
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '');
  try { return { json: JSON.parse(raw), binary: false }; }
  catch (error) { throw new Error(`C4D 导出的预览不是有效的 glTF：${error.message}`); }
}

function mimeFor(file) {
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream' };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** The exporter normally embeds resources; inline whatever it left on disk so the preview stays self-contained. */
async function inlineExternalResources(json, baseDir) {
  for (const key of ['buffers', 'images']) {
    for (const item of json[key] || []) {
      const uri = item?.uri;
      if (typeof uri !== 'string' || uri.startsWith('data:')) continue;
      let file;
      try { file = uri.startsWith('file:') ? fileURLToPath(uri) : (path.isAbsolute(uri) ? uri : path.resolve(baseDir, decodeURIComponent(uri))); }
      catch { throw new Error(`C4D 预览引用了无法解析的外部资源：${uri}`); }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 64 * 1024 * 1024) throw new Error(`C4D 预览引用了无法读取的外部资源：${uri}`);
      item.uri = `data:${mimeFor(file)};base64,${(await readFile(file)).toString('base64')}`;
    }
  }
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function composeMatrix(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) return node.matrix.slice();
  const [tx, ty, tz] = node?.translation || [0, 0, 0];
  // glTF 的旋转字段名是 rotation；只有部分库会写成 quaternion。
  const [qx, qy, qz, qw] = node?.rotation || node?.quaternion || [0, 0, 0, 1];
  const [sx, sy, sz] = node?.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function nodeWorldMatrices(json) {
  const nodes = json.nodes || [];
  const parent = new Map();
  nodes.forEach((node, index) => (node.children || []).forEach((child) => parent.set(child, index)));
  const scenes = json.scenes || [];
  const roots = Array.isArray(scenes[0]?.nodes) && scenes[0].nodes.length
    ? scenes[0].nodes
    : nodes.map((_, index) => index).filter((index) => !parent.has(index));
  const local = nodes.map((node) => composeMatrix(node));
  const world = new Map();
  const seen = new Set();
  const visit = (index, parentMatrix) => {
    if (seen.has(index)) return;
    seen.add(index);
    const matrix = multiplyMatrix(parentMatrix, local[index] || identityMatrix());
    world.set(index, matrix);
    for (const child of nodes[index]?.children || []) visit(child, matrix);
  };
  for (const root of roots) visit(root, identityMatrix());
  return world;
}

export function gltfNodeWorldMatrices(json) {
  return nodeWorldMatrices(json);
}

/** World-space bounds of every mesh node in a glTF JSON (mirrors the preview camera framing). */
export function gltfSceneBounds(json) {
  const nodes = json.nodes || [];
  const world = nodeWorldMatrices(json);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let found = false;
  nodes.forEach((node, index) => {
    const matrix = world.get(index);
    const bounds = accessorBounds(json, node);
    if (!matrix || !bounds) return;
    found = true;
    for (const x of [bounds.minimum[0], bounds.maximum[0]]) {
      for (const y of [bounds.minimum[1], bounds.maximum[1]]) {
        for (const z of [bounds.minimum[2], bounds.maximum[2]]) {
          const point = [
            matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
            matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
            matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
          ];
          for (let axis = 0; axis < 3; axis += 1) {
            minimum[axis] = Math.min(minimum[axis], point[axis]);
            maximum[axis] = Math.max(maximum[axis], point[axis]);
          }
        }
      }
    }
  });
  if (!found) return null;
  return { min: minimum, max: maximum, center: minimum.map((value, axis) => (value + maximum[axis]) / 2), size: minimum.map((value, axis) => maximum[axis] - value) };
}

/**
 * Fit the axis/scale mapping the C4D glTF exporter used, from matched object
 * positions: gltf[i] = scale * sign[i] * c4d[perm[i]].
 */
export function fitAxisMapping(pairs) {
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  // C4D 的 glTF 导出约定是 X/Y 不变、Z 镜像；把这一组合放在最前面，
  // 这样没有 Z 样本的场景也会优先采用约定值，而不是任意符号。
  const signs = [[1, 1, -1], [1, 1, 1], [1, -1, -1], [1, -1, 1], [-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1]];
  let best = null;
  for (const perm of permutations) {
    for (const sign of signs) {
      const ratios = [];
      let usable = true;
      for (const pair of pairs) {
        for (let axis = 0; axis < 3 && usable; axis += 1) {
          const source = pair.c4d?.[perm[axis]];
          if (!Number.isFinite(source) || Math.abs(source) < 1e-6) continue;
          const ratio = pair.gltf?.[axis] / (sign[axis] * source);
          if (!Number.isFinite(ratio) || ratio <= 0) { usable = false; break; }
          ratios.push(ratio);
        }
        if (!usable) break;
      }
      if (!usable || ratios.length < 2) continue;
      const minimum = Math.min(...ratios), maximum = Math.max(...ratios);
      const spread = maximum / minimum;
      if (spread > 1.02) continue;
      const sorted = ratios.slice().sort((a, b) => a - b);
      const scale = sorted[Math.floor(sorted.length / 2)];
      if (!best || spread < best.spread) best = { perm, sign, scale, spread, samples: ratios.length };
    }
  }
  if (!best) return null;
  return { permutation: best.perm, signs: best.sign, scale: best.scale, samples: best.samples, spread: Number(best.spread.toFixed(6)) };
}

function accessorBounds(json, node) {
  const mesh = (json.meshes || [])[node?.mesh];
  if (!mesh) return null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const primitive of mesh.primitives || []) {
    const accessorIndex = primitive?.attributes?.POSITION;
    const accessor = (json.accessors || [])[accessorIndex];
    if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max)) continue;
    found = true;
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], accessor.min[axis]);
      maximum[axis] = Math.max(maximum[axis], accessor.max[axis]);
    }
  }
  return found ? { minimum, maximum } : null;
}

function worldBoundsSize(matrix, bounds) {  const size = [0, 0, 0];
  const axes = [];
  for (const x of [bounds.minimum[0], bounds.maximum[0]]) {
    for (const y of [bounds.minimum[1], bounds.maximum[1]]) {
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) {
        const px = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        const py = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        const pz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        axes.push([px, py, pz]);
      }
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const values = axes.map((point) => point[axis]);
    size[axis] = Math.max(...values) - Math.min(...values);
  }
  return size;
}

/**
 * Fallback for scenes where every matched object sits at the origin: the
 * exporter's axis convention is fixed (C4D Y-up to glTF Y-up, Z mirrored), so
 * only the unit scale has to be recovered. World bounding boxes still carry it.
 */
function fitAxisMappingFromExtents(pairs) {
  const ratios = [];
  for (const pair of pairs) {
    for (let axis = 0; axis < 3; axis += 1) {
      const source = pair.c4d?.[axis];
      if (!Number.isFinite(source) || source < 1e-6) continue;
      const target = pair.gltf?.[axis];
      if (!Number.isFinite(target) || target < 1e-9) continue;
      ratios.push(target / source);
    }
  }
  if (ratios.length < 2) return null;
  const sorted = ratios.slice().sort((a, b) => a - b);
  const scale = sorted[Math.floor(sorted.length / 2)];
  const spread = sorted[sorted.length - 1] / sorted[0];
  if (!Number.isFinite(scale) || scale <= 0 || spread > 1.05) return null;
  return { permutation: [0, 1, 2], signs: [1, 1, -1], scale, samples: ratios.length, spread: Number(spread.toFixed(6)), derivedFrom: 'extents' };
}

/** Convert a preview (glTF) point back to C4D world units for sanity checks. */
export function previewPointToC4d(point, transform) {
  if (!transform || !Array.isArray(point) || point.length !== 3) return null;
  if (!Number.isFinite(transform.scale) || transform.scale === 0) return null;
  const out = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) out[transform.permutation[axis]] = point[axis] / (transform.scale * transform.signs[axis]);
  return out;
}

/** Attach stable ids to the exported glTF and derive the preview -> C4D mapping. */
export function c4dInjectPreview(json, manifest) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const byName = new Map();
  nodes.forEach((node, index) => {
    if (typeof node?.name !== 'string') return;
    const list = byName.get(node.name) || [];
    list.push(index);
    byName.set(node.name, list);
  });
  const parentOf = new Map();
  nodes.forEach((node, index) => (node.children || []).forEach((child) => parentOf.set(child, index)));
  const nodeName = (index) => nodes[index]?.name || '';
  const instanceNames = new Set((manifest.objects || []).filter(entry => entry.instanceOf).map(entry => entry.exportName));
  // 导出器会为「有材质的实例」额外生成一个与源对象同名的子节点，必须把它和真正的源对象区分开。
  const isInsideInstance = (index) => {
    const seen = new Set();
    let current = parentOf.get(index);
    while (current !== undefined && !seen.has(current)) {
      if (instanceNames.has(nodeName(current))) return true;
      seen.add(current);
      current = parentOf.get(current);
    }
    return false;
  };
  const subtreeMeshNodes = (index) => {
    const found = [];
    const stack = [...(nodes[index]?.children || [])];
    const seen = new Set();
    while (stack.length) {
      const child = stack.pop();
      if (seen.has(child) || !nodes[child]) continue;
      seen.add(child);
      if (nodes[child].mesh !== undefined) found.push(child);
      stack.push(...(nodes[child].children || []));
    }
    return found;
  };
  const objects = [];
  const unmatched = [];
  for (const entry of manifest.objects || []) {
    const named = byName.get(entry.exportName) || [];
    const filtered = named.filter(index => !isInsideInstance(index));
    let bound = null;
    if (entry.instanceOf) {
      const withMesh = filtered.filter(index => nodes[index]?.mesh !== undefined);
      if (withMesh.length === 1) bound = withMesh[0];
      else if (filtered.length === 1) {
        const descendants = subtreeMeshNodes(filtered[0]);
        if (descendants.length === 1) {
          bound = descendants[0];
          nodes[bound].name = entry.exportName;
        } else if (descendants.length > 1) {
          unmatched.push({ uid: entry.uid, name: entry.name, exportName: entry.exportName, reason: 'ambiguous' });
          continue;
        } else {
          bound = filtered[0];
        }
      }
    } else if (filtered.length === 1) {
      bound = filtered[0];
    }
    if (bound === null) {
      unmatched.push({ uid: entry.uid, name: entry.name, exportName: entry.exportName, reason: filtered.length ? 'ambiguous' : 'missing' });
      continue;
    }
    nodes[bound].extras = { ...(nodes[bound].extras || {}), point_edit_3d_uid: entry.uid };
    objects.push({ ...entry, nodeIndex: bound });
  }
  // 导出器生成的其它网格副本仍然要显示，但不作为独立可点选对象。
  const reachable = new Set();
  const roots = Array.isArray(json.scenes?.[0]?.nodes) && json.scenes[0].nodes.length
    ? json.scenes[0].nodes
    : nodes.map((_, index) => index).filter(index => !parentOf.has(index));
  const visit = (index) => {
    if (reachable.has(index) || !nodes[index]) return;
    reachable.add(index);
    for (const child of nodes[index].children || []) visit(child);
  };
  roots.forEach(visit);
  let generatedCopies = 0;
  nodes.forEach((node, index) => {
    if (!reachable.has(index) || node.mesh === undefined) return;
    if (node.extras?.point_edit_3d_uid) return;
    node.extras = { ...(node.extras || {}), point_edit_3d_skip: true };
    generatedCopies += 1;
  });
  const world = nodeWorldMatrices(json);
  const pairs = [];
  for (const entry of objects) {
    const matrix = world.get(entry.nodeIndex);
    if (!matrix) continue;
    if (Math.abs(entry.world?.[0] || 0) + Math.abs(entry.world?.[1] || 0) + Math.abs(entry.world?.[2] || 0) < 1e-6) continue;
    pairs.push({ c4d: entry.world, gltf: [matrix[12], matrix[13], matrix[14]] });
  }
  const transformFromPositions = fitAxisMapping(pairs);
  let transform = transformFromPositions
    ? { ...transformFromPositions, derivedFrom: 'positions', accuracy: transformFromPositions.spread <= 1.0001 ? 'exact' : 'approx' }
    : null;
  if (!transform) {
    const extentPairs = [];
    for (const entry of objects) {
      const matrix = world.get(entry.nodeIndex);
      if (!matrix) continue;
      const bounds = accessorBounds(json, nodes[entry.nodeIndex]);
      const box = entry.bbox;
      if (!bounds || !Array.isArray(box?.min) || !Array.isArray(box?.max)) continue;
      const gltfSize = worldBoundsSize(matrix, bounds);
      if (!gltfSize.some((value) => value > 1e-9)) continue;
      extentPairs.push({ c4d: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]], gltf: gltfSize });
    }
    const extentFit = fitAxisMappingFromExtents(extentPairs);
    transform = extentFit ? { ...extentFit, accuracy: 'approx' } : null;
  }
  const hidden = objects.filter((entry) => entry.hidden).length;
  const instances = objects.filter((entry) => entry.instanceOf).length;
  const unstable = objects.filter((entry) => entry.stable === false).length;
  const selectable = objects.filter((entry) => nodes[entry.nodeIndex]?.mesh !== undefined).length;
  const nonMesh = objects.length - selectable;
  const materialInfo = manifest.materials || {};
  const materialNames = new Set();
  for (const entry of objects) for (const name of entry.materials || []) materialNames.add(name);
  const approximateMaterials = [...materialNames].filter((name) => materialInfo[name] && materialInfo[name].standard === false);
  const texturedMaterials = [...materialNames].filter((name) => materialInfo[name] && materialInfo[name].hasShader);
  const warnings = [];
  if (hidden) warnings.push(`预览包含 ${hidden} 个在 C4D 中隐藏的对象`);
  if (instances) warnings.push(`预览包含 ${instances} 个实例对象；修改时可能应作用于源对象`);
  if (nonMesh > 0) warnings.push(`${nonMesh} 个对象（空物体、摄像机、灯光等）不是网格，无法在网页中点选`);
  if (approximateMaterials.length) warnings.push(`${approximateMaterials.length} 个材质不是标准 C4D 材质（${approximateMaterials.slice(0, 3).join('、')}${approximateMaterials.length > 3 ? '…' : ''}），预览只能近似显示`);
  if (texturedMaterials.length) warnings.push(`${texturedMaterials.length} 个材质使用贴图或程序化着色（${texturedMaterials.slice(0, 3).join('、')}${texturedMaterials.length > 3 ? '…' : ''}），预览可能不完整`);
  if (unmatched.length) warnings.push(`${unmatched.length} 个对象没有对应到预览节点，无法在网页中点选`);
  if (unstable) warnings.push(`${unstable} 个对象缺少稳定编号，相关批注可能无法回投`);
  if (!transform) warnings.push('无法确定预览与 C4D 的坐标换算，落点只作为参考');
  else if (transform.accuracy !== 'exact') warnings.push('预览与 C4D 的坐标换算为近似值，落点与三维框只作为参考');
  json.asset = json.asset || {};
  json.asset.extras = {
    ...(json.asset.extras || {}),
    point_edit_3d: {
      version: 1,
      source: 'c4d',
      scene_uid: manifest.sceneUid,
      preview_compatibility: {
        approximate_materials: approximateMaterials,
        textured_materials: texturedMaterials,
        has_instances: instances > 0,
        non_mesh_objects: nonMesh,
        transform_accuracy: transform?.accuracy ?? null,
        warnings,
      },
    },
  };
  return {
    json,
    objects,
    unmatched,
    transform,
    stats: { nodes: nodes.length, matched: objects.length, unmatched: unmatched.length, hidden, instances, unstable },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Scene access                                                        */
/* ------------------------------------------------------------------ */

async function exportPreviewScript(gltfPath, manifestPath) {
  return pyScript(`gltf_path = ${JSON.stringify(gltfPath)}
manifest_path = ${JSON.stringify(manifestPath)}
doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': False, 'error': 'C4D 中没有打开的文档'})
    return
entries = _collect_scene(doc)
if not entries:
    _emit({'ok': False, 'error': 'C4D 当前场景没有对象，请先建立或打开一个场景'})
    return
clone = doc.GetClone()
if clone is None:
    _emit({'ok': False, 'error': '无法复制 C4D 场景'})
    return
clone_objects = _flat_preorder(clone)
if len(clone_objects) != len(entries):
    _emit({'ok': False, 'error': '场景复制后对象数量不一致（%d/%d）' % (len(clone_objects), len(entries))})
    return
for entry, obj in zip(entries, clone_objects):
    obj.SetName(entry['exportName'])
if os.path.exists(gltf_path):
    os.remove(gltf_path)
saved = c4d.documents.SaveDocument(clone, gltf_path, c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, c4d.FORMAT_GLTFEXPORT)
if not saved or not os.path.exists(gltf_path):
    _emit({'ok': False, 'error': 'C4D glTF 导出失败'})
    return
manifest = {
    'version': 1,
    'source': 'c4d',
    'sceneUid': _scene_uid(doc),
    'document': _document_info(doc),
    'c4d': {'version': int(c4d.GetC4DVersion())},
    'exportedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'objects': entries,
    'materials': _material_info(doc),
}
with open(manifest_path, 'w', encoding='utf-8') as handle:
    json.dump(manifest, handle, ensure_ascii=False)
_emit({'ok': True, 'sceneUid': manifest['sceneUid'], 'objectCount': len(entries), 'materialCount': len(manifest['materials']), 'gltfBytes': os.path.getsize(gltf_path), 'c4dVersion': manifest['c4d']['version']})`, { collect: true });
}

/**
 * Export a preview of the cloned C4D document and read it back into memory.
 * The temporary directory (glTF, sidecar files and manifest) is always removed.
 */
export async function c4dExportPreview(options = {}) {
  const port = c4dPort(options.port);
  const timeoutSeconds = options.timeoutSeconds ?? 110;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'point-edit-3d-c4d-'));
  const gltfPath = path.join(directory, 'preview.gltf');
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    const payload = await runPython(await exportPreviewScript(gltfPath, manifestPath), { port, timeoutSeconds, timeoutMs: (timeoutSeconds + 20) * 1000 });
    if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 导出预览失败'));
    const buffer = await readFile(gltfPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const parsed = parseGltf(buffer);
    await inlineExternalResources(parsed.json, directory);
    return { json: parsed.json, binary: parsed.binary, manifest, bytes: buffer.length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function c4dSceneSummary(options = {}) {
  const payload = await runPython(pyScript(`doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': True, 'connected': True, 'sceneUid': None, 'document': None, 'objectCount': 0, 'materialCount': 0, 'message': 'C4D 已连接，但没有打开的文档'})
    return
_emit({'ok': True, 'connected': True, 'sceneUid': _scene_uid(doc), 'document': _document_info(doc), 'objectCount': len(_flat_preorder(doc)), 'materialCount': len(doc.GetMaterials()), 'c4dVersion': int(c4d.GetC4DVersion()), 'frame': doc.GetTime().GetFrame(doc.GetFps())})`, { collect: true }), { port: options.port, timeoutSeconds: 45 });
  if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 场景读取失败'));
  return payload;
}

export async function c4dSceneObjects(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 2000;
  const payload = await runPython(pyScript(`doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': False, 'error': 'C4D 中没有打开的文档'})
    return
entries = _collect_scene(doc)
_emit({'ok': True, 'sceneUid': _scene_uid(doc), 'document': _document_info(doc), 'objects': entries[:${limit}], 'objectCount': len(entries), 'truncated': len(entries) > ${limit}})`, { collect: true }), { port: options.port, timeoutSeconds: 60 });
  if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 场景读取失败'));
  return payload;
}

export async function c4dIdentity({ sceneUid, uids, port } = {}, options = {}) {
  const payload = await runPython(pyScript(`expected = ${JSON.stringify(String(sceneUid || ''))}
requested = ${JSON.stringify(Array.isArray(uids) ? uids : [])}
doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': True, 'result': {'scene_uid': None, 'scene_matches': False, 'objects': [{'uid': uid, 'resolved': False} for uid in requested], 'document': None, 'message': 'C4D 中没有打开的文档'}})
    return
flat = _flat_preorder(doc)
index = {}
duplicates = []
for position, op in enumerate(flat):
    guid = op.GetGUID()
    uid = _hid(['object', guid]) if guid else _hid(['object-fallback', position, op.GetName() or '', _object_path(op)])
    if uid in index:
        duplicates.append(uid)
    index[uid] = op
items = []
for uid in requested:
    op = index.get(uid)
    item = {'uid': uid, 'resolved': op is not None and uid not in duplicates}
    if op is not None:
        parent = op.GetUp()
        parent_guid = parent.GetGUID() if parent is not None else 0
        item['name'] = op.GetName()
        item['type'] = int(op.GetType())
        item['typeName'] = _type_name(op)
        item['path'] = _object_path(op)
        item['parentUid'] = _hid(['object', parent_guid]) if parent_guid else None
        item['bbox'] = _world_bbox(op)
        item['world'] = [op.GetMg().off.x, op.GetMg().off.y, op.GetMg().off.z]
        item['materials'] = _material_names(op)
        item['hidden'] = _editor_hidden(op)
        item['instanceOf'] = _instance_target(op).GetName() if _instance_target(op) is not None else None
    items.append(item)
live = _scene_uid(doc)
_emit({'ok': True, 'result': {'scene_uid': live, 'scene_matches': live == expected, 'objects': items, 'document': _document_info(doc), 'duplicates': duplicates, 'objectCount': len(flat)}})`, { collect: true }), { port, timeoutSeconds: 60, ...options });
  if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 身份核验失败'));
  return payload.result;
}

export async function c4dObjectInfo({ uid, port } = {}, options = {}) {
  const payload = await runPython(pyScript(`target_uid = ${JSON.stringify(String(uid || ''))}
doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': False, 'error': 'C4D 中没有打开的文档'})
    return
found = None
for op in _flat_preorder(doc):
    guid = op.GetGUID()
    candidate = _hid(['object', guid]) if guid else None
    if candidate == target_uid:
        found = op
        break
if found is None:
    _emit({'ok': True, 'result': {'uid': target_uid, 'resolved': False}})
    return
matrix = found.GetMg()
parent = found.GetUp()
_emit({'ok': True, 'result': {
    'uid': target_uid,
    'resolved': True,
    'name': found.GetName(),
    'type': int(found.GetType()),
    'typeName': _type_name(found),
    'path': _object_path(found),
    'world': [matrix.off.x, matrix.off.y, matrix.off.z],
    'bbox': _world_bbox(found),
    'materials': _material_names(found),
    'hidden': _editor_hidden(found),
    'instanceOf': (_instance_target(found).GetName() if _instance_target(found) is not None else None),
    'parentUid': _hid(['object', parent.GetGUID()]) if parent is not None and parent.GetGUID() else None,
    'parentName': parent.GetName() if parent is not None else None,
    'childCount': len(found.GetChildren()) if hasattr(found, 'GetChildren') else None,
    'sceneUid': _scene_uid(doc),
    'document': _document_info(doc),
}})`, { collect: true }), { port, timeoutSeconds: 60, ...options });
  if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 对象读取失败'));
  return payload.result;
}

/**
 * Run caller Python against verified C4D objects. A native .c4d recovery copy
 * is written before the script runs; the user's document is never saved.
 */
export async function c4dExecute({ sceneUid, uids, code, backupPath = '', port } = {}, options = {}) {
  const configuredLimit = Number.parseInt(process.env.POINT_EDIT_3D_DELETE_UNDO_MAX_OBJECTS || '5000', 10);
  const maxDeleteUndo = Number.isFinite(configuredLimit) ? Math.max(0, Math.min(50000, configuredLimit)) : 5000;
  const payload = await runPython(pyScript(`expected = ${JSON.stringify(String(sceneUid || ''))}
requested = ${JSON.stringify(Array.isArray(uids) ? uids : [])}
backup_path = ${JSON.stringify(String(backupPath || ''))}
code = ${JSON.stringify(String(code || ''))}
max_delete_undo = ${JSON.stringify(maxDeleteUndo)}
doc = c4d.documents.GetActiveDocument()
if doc is None:
    _emit({'ok': True, 'executed': False, 'error': 'C4D 中没有打开的文档'})
    return
live = _scene_uid(doc)
if live != expected:
    _emit({'ok': True, 'executed': False, 'error': 'C4D 场景身份已变化，请重新打开预览后再批注', 'scene_uid': live})
    return
flat = _flat_preorder(doc)
index = {}
duplicates = []
for op in flat:
    guid = op.GetGUID()
    uid = _hid(['object', guid]) if guid else None
    if uid is None:
        continue
    if uid in index:
        duplicates.append(uid)
    index[uid] = op
missing = []
resolved = []
for uid in requested:
    op = index.get(uid)
    if op is None or uid in duplicates:
        missing.append(uid)
    else:
        resolved.append((uid, op))
if missing:
    _emit({'ok': True, 'executed': False, 'error': '目标物体在当前 C4D 场景中不存在或编号不唯一', 'missing': missing})
    return
backup = ''
if backup_path:
    try:
        folder = os.path.dirname(backup_path)
        if folder and not os.path.isdir(folder):
            os.makedirs(folder)
        if os.path.exists(backup_path):
            os.remove(backup_path)
        saved = c4d.documents.SaveDocument(doc.GetClone(), backup_path, c4d.SAVEDOCUMENTFLAGS_DONTADDTORECENTLIST, c4d.FORMAT_C4DEXPORT)
        if not saved or not os.path.exists(backup_path):
            _emit({'ok': True, 'executed': False, 'error': '无法创建 C4D 恢复副本', 'backup_requested': backup_path})
            return
        backup = backup_path
    except Exception:
        _emit({'ok': True, 'executed': False, 'error': '无法创建 C4D 恢复副本：' + traceback.format_exc(), 'backup_requested': backup_path})
        return
results = []
def emit(value):
    results.append(value)
targets = []
for uid, op in resolved:
    targets.append({'uid': uid, 'name': op.GetName(), 'type': int(op.GetType()), 'obj': op})
namespace = {'c4d': c4d, 'doc': doc, 'targets': targets, 'targets_by_name': {t['name']: t['obj'] for t in targets}, 'target': targets[0]['obj'] if targets else None, 'emit': emit, 'results': results, 'os': os, 'documents': c4d.documents}

def _state(op):
    matrix = op.GetMg()
    return {'name': op.GetName(), 'type': int(op.GetType()), 'typeName': _type_name(op), 'world': [matrix.off.x, matrix.off.y, matrix.off.z], 'bbox': _world_bbox(op), 'materials': _material_names(op), 'hidden': _editor_hidden(op)}

def _ident(item):
    try:
        guid = item.GetGUID()
        if guid:
            return 'g' + str(guid)
    except Exception:
        pass
    return 'h' + str(hash(item))

def _snapshot():
    objects = {}
    tags = {}
    for op in _flat_preorder(doc):
        objects[_ident(op)] = op
        try:
            for tag in op.GetTags():
                tags[_ident(tag)] = tag
        except Exception:
            pass
    materials = {}
    for material in doc.GetMaterials():
        materials[_ident(material)] = material
    return objects, tags, materials

undo = {'group': False, 'changes': 0, 'additions': 0, 'deletedObjects': False, 'materialsSkipped': 0, 'objects': len(flat), 'deleteUndo': {'registered': False, 'objects': 0, 'skipped': 0, 'ms': 0}}
before = _snapshot()
_max_delete_undo = max_delete_undo
if _max_delete_undo < 0:
    _max_delete_undo = 0
try:
    doc.StartUndo()
    undo['group'] = True
    target_guids = set(_ident(op) for _, op in resolved)
    if len(flat) <= _max_delete_undo:
        import time as _undo_time
        _started = _undo_time.perf_counter()
        _count = 0
        for _item in flat:
            if _ident(_item) in target_guids:
                continue
            doc.AddUndo(c4d.UNDOTYPE_DELETEOBJ, _item)
            _count += 1
        undo['deleteUndo'] = {'registered': True, 'objects': _count, 'skipped': len(flat) - _count, 'ms': round((_undo_time.perf_counter() - _started) * 1000, 1), 'limit': _max_delete_undo}
    else:
        undo['deleteUndo'] = {'registered': False, 'objects': 0, 'skipped': len(flat), 'reason': 'too_many_objects', 'limit': _max_delete_undo}
    for uid, op in resolved:
        doc.AddUndo(c4d.UNDOTYPE_CHANGE, op)
        undo['changes'] += 1
    materials = doc.GetMaterials()
    if len(materials) <= 200:
        for material in materials:
            doc.AddUndo(c4d.UNDOTYPE_CHANGE, material)
    else:
        undo['materialsSkipped'] = len(materials)
except Exception:
    undo['group'] = False

failed = False
failure = ''
try:
    exec(compile(code, '<point-edit-3d>', 'exec'), namespace)
except Exception:
    failed = True
    failure = traceback.format_exc()

after = _snapshot()
if undo['group']:
    try:
        for guid, op in after[0].items():
            if guid not in before[0]:
                doc.AddUndo(c4d.UNDOTYPE_NEW, op)
                undo['additions'] += 1
        for guid, tag in after[1].items():
            if guid not in before[1]:
                doc.AddUndo(c4d.UNDOTYPE_NEW, tag)
                undo['additions'] += 1
        for guid, material in after[2].items():
            if guid not in before[2]:
                doc.AddUndo(c4d.UNDOTYPE_NEW, material)
                undo['additions'] += 1
        undo['deletedObjects'] = any(guid not in after[0] for guid in before[0])
        doc.EndUndo()
    except Exception:
        undo['group'] = False
        try:
            doc.EndUndo()
        except Exception:
            pass

if failed:
    _emit({'ok': True, 'executed': True, 'failed': True, 'error': failure, 'backup': backup, 'results': results, 'targets': [{'uid': t['uid'], **_state(t['obj'])} for t in targets], 'scene_uid': live, 'undo': undo})
    return
c4d.EventAdd()
_emit({'ok': True, 'executed': True, 'failed': False, 'backup': backup, 'results': results, 'targets': [{'uid': t['uid'], **_state(t['obj'])} for t in targets], 'scene_uid': live, 'document': _document_info(doc), 'materials': [m.GetName() for m in doc.GetMaterials()], 'undo': undo})`, { collect: true }), { port, timeoutSeconds: options.timeoutSeconds ?? 110, timeoutMs: options.timeoutMs ?? 130000 });
  if (!payload?.ok) throw new Error(String(payload?.error || 'C4D 执行失败'));
  return payload;
}

/* ------------------------------------------------------------------ */
/* C4D bridge plugin install / rollback (files only)                   */
/* ------------------------------------------------------------------ */

export const C4D_BRIDGE_FILES = ['mcp_server_plugin.pyp', 'scene_nodes_patterns.py', 'LICENSE'];

/**
 * Copy the bundled C4D bridge plugin into a user plugin directory.
 * Identical files are left alone; differing files are backed up as
 * `<name>.bak-<timestamp>` before being replaced. Returns the actions so a
 * caller (or test) can roll back.
 */
export async function installC4dPlugin({ sourceDirectory, targetDirectory, files = C4D_BRIDGE_FILES }) {
  const entries = [];
  await mkdir(targetDirectory, { recursive: true });
  for (const name of files) {
    const source = path.join(sourceDirectory, name);
    let next = null;
    try { next = await readFile(source); } catch { entries.push({ name, action: 'missing_source' }); continue; }
    const destination = path.join(targetDirectory, name);
    let current = null;
    try { current = await readFile(destination); } catch { current = null; }
    if (current && current.equals(next)) { entries.push({ name, action: 'unchanged' }); continue; }
    if (current) {
      const backup = `${destination}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await copyFile(destination, backup);
      await copyFile(source, destination);
      entries.push({ name, action: 'replaced', backup });
    } else {
      await copyFile(source, destination);
      entries.push({ name, action: 'created' });
    }
  }
  return { targetDirectory, files: entries };
}

/** Undo an installC4dPlugin() result: remove new files, restore replaced ones. */
export async function rollbackC4dPlugin({ targetDirectory, files }) {
  const restored = [];
  for (const entry of files || []) {
    const destination = path.join(targetDirectory, entry.name);
    if (entry.action === 'created') {
      await unlink(destination).catch(() => {});
      restored.push({ name: entry.name, action: 'removed' });
    } else if (entry.action === 'replaced' && entry.backup) {
      await copyFile(entry.backup, destination);
      restored.push({ name: entry.name, action: 'restored', backup: entry.backup });
    }
  }
  return { targetDirectory, files: restored };
}

/* ------------------------------------------------------------------ */
/* Scene manifest store (web object -> C4D object mapping)             */
/* ------------------------------------------------------------------ */

export function c4dSceneDir(inboxDirectory) {
  return path.join(path.dirname(inboxDirectory), 'c4d');
}

function sceneFile(directory, sceneUid) {
  if (!/^[a-f0-9]{32}$/.test(String(sceneUid || ''))) throw new Error('无效的 C4D 场景编号');
  return path.join(directory, `${sceneUid}.json`);
}

export async function saveC4dScene(directory, record) {
  const file = sceneFile(directory, record?.sceneUid);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...record, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  await rename(temporary, file);
  await pruneC4dScenes(directory, 20);
  return file;
}

export async function loadC4dScene(directory, sceneUid) {
  let file;
  try { file = sceneFile(directory, sceneUid); } catch { return null; }
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function pruneC4dScenes(directory, keep = 20) {
  let names = [];
  try { names = await readdir(directory); } catch { return; }
  const files = names.filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  if (files.length <= keep) return;
  const stats = [];
  for (const name of files) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info) stats.push({ name, time: info.mtimeMs });
  }
  stats.sort((a, b) => b.time - a.time);
  for (const item of stats.slice(keep)) await unlink(path.join(directory, item.name)).catch(() => {});
}
