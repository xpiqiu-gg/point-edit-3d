import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const inbox = await mkdtemp(path.join(os.tmpdir(),'point-edit-3d-test-'));
const transport = new StdioClientTransport({command:process.execPath,args:[process.argv[2]],env:{...process.env,POINT_EDIT_3D_DATA_DIR:inbox},stderr:'pipe'});
transport.stderr.on('data', data => process.stderr.write(data));
const client = new Client({name:'point-edit-3d-test',version:'1'});
await client.connect(transport);
const call = async (name,args={}) => JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
try {
  const opened = await call('point_edit_3d_open');
  assert.ok(opened.blenderConnected, 'Blender disconnected');
  assert.equal((await call('point_edit_3d_read',{sessionId:opened.sessionId})).status,'pending');
  const {origin} = new URL(opened.url);
  assert.equal((await fetch(opened.url)).status,200);
  const scene = await fetch(origin+'/__point_edit_3d/current-scene',{method:'POST',headers:{Origin:origin}});
  assert.equal(scene.status,200, await scene.clone().text());
  const data=Buffer.from(await scene.arrayBuffer()); assert.equal(data.subarray(0,4).toString(),'glTF');
  const annotation={id:'test',intent:'question',text:'测试批注原文',scope:'viewport',targets:[],rays:[],references:[]};
  const body={app:'point-edit-3d',sessionId:opened.sessionId,clientId:crypto.randomUUID(),sequence:1,annotations:[annotation]};
  const post=async value => fetch(origin+'/__point_edit_3d/submit',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post(body)).status,200);
  const result=await call('point_edit_3d_read',{sessionId:opened.sessionId});
  assert.equal(result.status,'submitted'); assert.equal(result.snapshot.annotations[0].text,annotation.text);
  assert.equal((await call('point_edit_3d_sessions')).sessions.length,1);
  assert.equal((await post({...body,sequence:2,annotations:[]})).status,200);
  assert.equal((await call('point_edit_3d_read',{sessionId:opened.sessionId})).status,'empty');
  const other = await call('point_edit_3d_open');
  const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1400,height:900}});
    await page.goto(other.url);
    await page.getByText(/已读取 Blender 当前场景/).waitFor({timeout:90000});
    await page.getByRole('button',{name:/整幅/}).click();
    await page.locator('textarea').first().fill('真实网页端批注测试');
    await page.getByRole('button',{name:'记下这条批注'}).click();
    await page.getByText('批注已提交，可回到 Codex 说“继续”。').waitFor({timeout:10000});
    const read=await call('point_edit_3d_read',{sessionId:other.sessionId});
    assert.equal(read.snapshot.annotations[0].text,'真实网页端批注测试');
    assert.equal(read.snapshot.annotations[0].scope,'viewport');
  } finally { await browser.close(); }
  console.log(JSON.stringify({ok:true,glbBytes:data.length,read:'submitted and empty snapshots',inbox}));
} finally { await client.close(); }
