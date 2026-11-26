import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export { blenderCommand } from './scene-adapters.mjs';
import { createBlenderAdapter } from './scene-adapters.mjs';
import { c4dExportPreview, c4dIdentity, c4dInjectPreview, c4dPort, c4dSceneDir, saveC4dScene } from './scene-c4d.mjs';

export function pointEditBridge({ directory = resolve('point-edit-3d-inbox'), blenderPort = 9877 } = {}) {
  let pendingSnapshot = null;
  const adapter = createBlenderAdapter(blenderPort);
  return {
    name: 'point-edit-3d-bridge',
    configureServer(server) {
      server.middlewares.use('/__point_edit_3d/shortcuts', async (req, res) => {
        const origin=req.headers.origin, host=req.headers.host || '';
        if (!/^127\.0\.0\.1:\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.headers['x-point-edit'] !== 'shortcuts') return res.writeHead(403).end();
        const file=resolve(directory,'shortcut-settings.json');
        try {
          if(req.method==='GET') {
            let shortcuts=null;try {shortcuts=JSON.parse(await readFile(file,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
            return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true,shortcuts}));
          }
          if(req.method!=='POST' || origin!==`http://${host}` || !req.headers['content-type']?.startsWith('application/json')) return res.writeHead(403).end();
          let body='';for await(const chunk of req){body+=chunk;if(body.length>4096) throw new Error('设置过大');}
          const value=JSON.parse(body);const ids=['look','pick','box','volume','frame','undo','move','scale','confirm','reset'];
          if(!value || typeof value!=='object' || Object.keys(value).length!==ids.length || ids.some(id=>typeof value[id]!=='string'||!value[id]||value[id].length>80) || new Set(ids.map(id=>value[id])).size!==ids.length) throw new Error('无效的快捷键设置');
          await mkdir(directory,{recursive:true});await writeFile(file,JSON.stringify(value),'utf8');
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true}));
        } catch(error) {res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:false,error:String(error)}));}
      });
      server.middlewares.use('/__point_edit_3d/language', async (req, res) => {
        const origin=req.headers.origin, host=req.headers.host || '';
        if (!/^127\.0\.0\.1:\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.headers['x-point-edit'] !== 'language') return res.writeHead(403).end();
        const file=resolve(directory,'language-settings.json');
        try {
          if (req.method==='GET') { let language='zh'; try { const saved=JSON.parse(await readFile(file,'utf8')); if(saved.language==='en') language='en'; } catch(e) { if(e.code!=='ENOENT') throw e; } return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({language})); }
          if(req.method!=='POST' || origin!==`http://${host}` || !req.headers['content-type']?.startsWith('application/json')) return res.writeHead(403).end();
          let body=''; for await(const chunk of req) { body+=chunk; if(body.length>1024) throw new Error('Invalid settings'); }
          const {language}=JSON.parse(body); if(language!=='zh' && language!=='en') throw new Error('Invalid language');
          await mkdir(directory,{recursive:true}); await writeFile(file,JSON.stringify({language}),'utf8');
          return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true}));
        } catch(e) {return res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({ok:false}));}
      });
      server.middlewares.use('/__point_edit_3d/view-settings', async (req, res) => {
        const origin=req.headers.origin, host=req.headers.host || '';
        if (!/^127\.0\.0\.1:\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.headers['x-point-edit'] !== 'view-settings') return res.writeHead(403).end();
        const file=resolve(directory,'view-settings.json');
        try {
          if(req.method==='GET') {let settings=null;try{settings=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}return res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true,settings}));}
          if(req.method!=='POST' || origin!==`http://${host}` || !req.headers['content-type']?.startsWith('application/json')) return res.writeHead(403).end();
          let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)throw new Error('设置过大');}
          const value=JSON.parse(body);
          if(!value || !Number.isFinite(value.fov) || value.fov<30 || value.fov>100 || !Number.isFinite(value.nearFactor) || value.nearFactor<0.1 || value.nearFactor>10)throw new Error('无效的视野设置');
          await mkdir(directory,{recursive:true});await writeFile(file,JSON.stringify({fov:value.fov,nearFactor:value.nearFactor}),'utf8');
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:true}));
        }catch(error){res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:false,error:String(error)}));}
      });
      server.middlewares.use('/__point_edit_3d/current-scene', async (req, res) => {
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return res.writeHead(403).end();
        try {
          if (req.headers['x-point-edit-scene'] === 'c4d') {
            try {
              const preview = await c4dExportPreview({ port: c4dPort() });
              const injected = c4dInjectPreview(preview.json, preview.manifest);
              await saveC4dScene(c4dSceneDir(directory), {
                version: 1,
                sceneUid: preview.manifest.sceneUid,
                document: preview.manifest.document,
                c4d: preview.manifest.c4d,
                transform: injected.transform,
                stats: injected.stats,
                warnings: injected.warnings,
                objects: injected.objects,
                unmatched: injected.unmatched,
                previewBytes: preview.bytes,
              });
              const body = Buffer.from(JSON.stringify(injected.json), 'utf8');
              return res.writeHead(200, {'Content-Type':'model/gltf+json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(body);
            } catch (error) {
              return res.writeHead(503, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:false,error:String(error)}));
            }
          }
          if (!pendingSnapshot) {
            pendingSnapshot = (async () => {
              let result;
              try { result = await adapter.command('point_edit_3d_export_preview', {in_memory:true}, 90000); }
              catch (error) {
                if (/unexpected keyword argument.*in_memory/i.test(String(error))) throw new Error('Blender 当前运行的是旧版 Point Edit 3D，无法使用内存预览。请在 Blender 插件设置中关闭再启用 Point Edit 3D；如果仍未解决，请在保留场景后重启 Blender。');
                throw error;
              }
              if (typeof result.glb_base64 !== 'string') throw new Error('Blender 插件版本过旧，请重新启用 Point Edit 3D');
              const glb = Buffer.from(result.glb_base64, 'base64');
              if (glb.length !== result.bytes || glb.subarray(0,4).toString('ascii') !== 'glTF') throw new Error('内存 GLB 数据无效');
              return glb;
            })().finally(() => { pendingSnapshot = null; });
          }
          const glb = await pendingSnapshot;
          res.writeHead(200, {'Content-Type':'model/gltf-binary','Cache-Control':'no-store'}).end(glb);
        } catch (error) { res.writeHead(503, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({ok:false,error:String(error)})); }
      });
      server.middlewares.use('/__point_edit_3d/identity', async (req, res) => {
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || !req.headers['content-type']?.startsWith('application/json')) return res.writeHead(403).end();
        try {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('请求过大'); }
          const {sceneUid, uids, source} = JSON.parse(body);
          if (typeof sceneUid !== 'string' || !/^[a-f0-9]{32}$/.test(sceneUid) || !Array.isArray(uids) || uids.length > 1000 || uids.some(uid => typeof uid !== 'string' || !/^[a-f0-9]{32}$/.test(uid))) throw new Error('无效身份');
          const result = source === 'c4d'
            ? await c4dIdentity({sceneUid, uids, port:c4dPort()})
            : await adapter.command('point_edit_3d_identity', {scene_uid:sceneUid,uids});
          res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'}).end(JSON.stringify({ok:true, result}));
        } catch (error) { res.writeHead(503, {'Content-Type':'application/json'}).end(JSON.stringify({ok:false, error:String(error)})); }
      });
      server.middlewares.use('/__point_edit_3d/submit', async (req, res) => {
        const origin = req.headers.origin;
        const expected = `http://${req.headers.host}`;
        if (req.method !== 'POST' || origin !== expected || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || !req.headers['content-type']?.startsWith('application/json')) {
          res.writeHead(403).end(); return;
        }
        try {
          let size = 0, chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 20 * 1024 * 1024) { res.writeHead(413).end(); return; }
            chunks.push(chunk);
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (payload.app !== 'point-edit-3d' || typeof payload.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.sessionId) || !Array.isArray(payload.annotations) || typeof payload.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.clientId) || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || payload.annotations.length > 1000) throw new Error('invalid payload');
          await mkdir(directory, { recursive: true });
          const id = randomUUID();
          const record = { ...payload, receivedAt: new Date().toISOString(), submissionId: id };
          await writeFile(resolve(directory, `${Date.now()}-${id}.json`), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, submissionId: id }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });
    },
  };
}
