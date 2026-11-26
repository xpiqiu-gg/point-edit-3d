import net from 'node:net';
import assert from 'node:assert/strict';
import {blenderCommand} from './bridge.mjs';
const payload='A'.repeat(4*1024*1024);
const server=net.createServer(s=>s.on('data',()=>{const json=JSON.stringify({status:'success',result:{glb_base64:payload}});for(let i=0;i<json.length;i+=8192)s.write(json.slice(i,i+8192));s.end();}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {const result=await blenderCommand('test',{},server.address().port,30000);assert.equal(result.glb_base64,payload);console.log('LARGE_MEMORY_STREAM_OK');}
finally {await new Promise(r=>server.close(r));}
