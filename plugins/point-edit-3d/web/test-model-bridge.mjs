import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp, writeFile} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const inbox=await mkdtemp(path.join(os.tmpdir(),'point-edit-model-test-'));
let calls=[];
const fake=net.createServer(socket=>socket.on('data',buffer=>{
  const command=JSON.parse(buffer.toString()); calls.push(command);
  socket.end(JSON.stringify({status:'success',result:{executed:true,backup_path:'test-only.blend'}}));
}));
await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));
const transport=new StdioClientTransport({command:process.execPath,args:[process.argv[2]],env:{...process.env,POINT_EDIT_3D_DATA_DIR:inbox,POINT_EDIT_3D_BLENDER_PORT:String(fake.address().port)}});
const client=new Client({name:'point-edit-model-test',version:'1'}); await client.connect(transport);
const call=async (name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
const sessionId=randomUUID(), submissionId=randomUUID(), annotationId=randomUUID(), questionId=randomUUID();
const sceneUid='a'.repeat(32), object='b'.repeat(32), surface='c'.repeat(32);
const targets=[{objectId:object,sceneUid,role:'object',included:true},{objectId:surface,sceneUid,role:'surface',included:false}];
const note={id:annotationId,intent:'edit',identity:'blender_uid',scope:'objects',sceneUid,text:'修改物体，桌子只是落点',targets};
await writeFile(path.join(inbox,`1-${submissionId}.json`),JSON.stringify({app:'point-edit-3d',sessionId,submissionId,annotations:[note,{...note,id:questionId,intent:'question'}]}));
const request={sessionId,submissionId,annotationId,targetUids:[object],code:'point_edit_targets[0].location.x += 1'};
try {
  assert.equal((await call('point_edit_3d_execute',{...request,annotationId:questionId})).ok,false);
  assert.equal((await call('point_edit_3d_execute',{...request,submissionId:randomUUID()})).ok,false);
  assert.equal((await call('point_edit_3d_execute',{...request,targetUids:[surface]})).ok,false);
  assert.equal((await call('point_edit_3d_execute',{...request,targetUids:['d'.repeat(32)]})).ok,false);
  assert.equal(calls.length,0);
  const result=await call('point_edit_3d_execute',request);
  assert.equal(result.ok,true); assert.equal(calls.length,1); assert.deepEqual(calls[0].params.uids,[object]);
  console.log('MCP_EDIT_SCOPE_TEST_OK');
} finally {await client.close(); await new Promise(resolve=>fake.close(resolve));}
