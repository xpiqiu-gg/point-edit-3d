import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,access} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const temp=await mkdtemp(path.join(os.tmpdir(),'point-edit-e2e-'));
const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
const blender=spawn('C:/Program Files/Blender Foundation/Blender 5.3/blender.exe',['--background','--factory-startup','--python-exit-code','1','--python','../blender/test_model_tcp.py','--',String(port)],{env:{...process.env,USERPROFILE:temp},stdio:['ignore','pipe','pipe']});
try {
 await new Promise((resolve,reject)=>{let output=''; const timer=setTimeout(()=>reject(new Error('Blender start timeout: '+output)),30000); blender.stdout.on('data',data=>{output+=data; if(output.includes('TEST_SERVER_READY')) {clearTimeout(timer);resolve();}}); blender.stderr.on('data',data=>output+=data); blender.on('exit',code=>{clearTimeout(timer);reject(new Error('Blender exited '+code+': '+output));});});
 const transport=new StdioClientTransport({command:process.execPath,args:[process.argv[2]],env:{...process.env,POINT_EDIT_3D_DATA_DIR:temp,POINT_EDIT_3D_BLENDER_PORT:String(port)}});
 const client=new Client({name:'e2e-test',version:'1'}); await client.connect(transport);
 try {
  const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
  const sessionId=randomUUID(),submissionId=randomUUID(),annotationId=randomUUID(),sceneUid='a'.repeat(32),uid='b'.repeat(32);
  const record={app:'point-edit-3d',sessionId,submissionId,annotations:[{id:annotationId,intent:'edit',identity:'blender_uid',scope:'objects',sceneUid,text:'将方块沿 X 轴移动 2',targets:[{objectId:uid,sceneUid,role:'object',included:true}]}]};
  await writeFile(path.join(temp,`1-${submissionId}.json`),JSON.stringify(record));
  const result=await call('point_edit_3d_execute',{sessionId,submissionId,annotationId,targetUids:[uid],code:'point_edit_targets[0].location.x += 2'});
  assert.equal(result.ok,true,JSON.stringify(result)); await access(result.result.backup_path);
  const info=await call('point_edit_3d_object_info',{sceneUid,uid}); assert.equal(info.ok,true,JSON.stringify(info)); assert.equal(info.result.world_location[0],2);
  console.log('REAL_BLENDER_MCP_E2E_OK');
 } finally { await client.close(); }
} finally {blender.kill();}
