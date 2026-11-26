import net from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {chromium} from 'playwright';
const fake=net.createServer(s=>s.on('data',data=>{const req=JSON.parse(data.toString());s.end(JSON.stringify(req.type==='ping'?{status:'success',result:{pong:true}}:{status:'error',message:"BlenderMCPServer.point_edit_3d_export_preview() got an unexpected keyword argument 'in_memory'"}));}));
await new Promise(r=>fake.listen(0,'127.0.0.1',r));
const inbox=await mkdtemp(path.join(os.tmpdir(),'point-edit-old-addon-test-'));
const transport=new StdioClientTransport({command:process.execPath,args:[process.argv[2]],env:{...process.env,POINT_EDIT_3D_DATA_DIR:inbox,POINT_EDIT_3D_BLENDER_PORT:String(fake.address().port)}});
const client=new Client({name:'old-addon-test',version:'1'}); await client.connect(transport);
try {
 const opened=JSON.parse((await client.callTool({name:'point_edit_3d_open',arguments:{}})).content[0].text);
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-swiftshader']});
 try {const page=await browser.newPage(); await page.goto(opened.url); const error=page.getByText(/Blender 当前运行的是旧版 Point Edit 3D/); await error.waitFor({timeout:10000}); assert.match(await error.innerText(),/关闭再启用/); assert.equal(await page.getByText('预览未载入').count(),1); console.log('OLD_ADDON_DIAGNOSIS_OK');}
 finally {await browser.close();}
} finally {await client.close();await new Promise(r=>fake.close(r));}
