import {spawn} from 'node:child_process';
import {createReadStream,statSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import net from 'node:net';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const temp=await mkdtemp(path.join(os.tmpdir(),'point-edit-pivot-test-'));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const sceneArgs=process.env.POINT_EDIT_TEST_SCENE_FILE?[process.env.POINT_EDIT_TEST_SCENE_FILE]:[];
const blender=spawn('C:/Program Files/Blender Foundation/Blender 5.3/blender.exe',['--background','--factory-startup',...sceneArgs,'--python-exit-code','1','--python','../blender/test_model_tcp.py','--',String(port)],{env:{...process.env,USERPROFILE:temp,TEMP:temp,TMP:temp},stdio:['ignore','pipe','pipe']});
try {
 await new Promise((resolve,reject)=>{let out='';const t=setTimeout(()=>reject(new Error('Blender startup timeout '+out)),30000);blender.stdout.on('data',v=>{out+=v;if(out.includes('TEST_SERVER_READY')){clearTimeout(t);resolve();}});blender.stderr.on('data',v=>out+=v);});
 // The Vite bridge uses its default port; isolate this test by overriding its config.
 const {pointEditBridge}=await import('./bridge.mjs');
 const server=await createServer({configFile:false,root:process.cwd(),optimizeDeps:{exclude:['three-mesh-bvh']},plugins:[...(process.env.POINT_EDIT_TEST_GLB?[{name:'test-glb',configureServer(server){server.middlewares.use('/__point_edit_3d/current-scene',(_req,res)=>{res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':statSync(process.env.POINT_EDIT_TEST_GLB).size});createReadStream(process.env.POINT_EDIT_TEST_GLB).pipe(res);});}}]:[]),(await import('@vitejs/plugin-react')).default(),(await import('@tailwindcss/vite')).default(),pointEditBridge({directory:path.join(temp,'inbox'),blenderPort:port})],resolve:{alias:{'@':path.join(process.cwd(),'src')}},server:{host:'127.0.0.1',port:0}});
 await server.listen();
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage({viewport:{width:1400,height:900}});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?session=12345678-1234-1234-1234-123456789abc`);await page.getByText(/已读取 Blender 当前场景/).waitFor({timeout:90000});
  await page.getByRole('button',{name:'设置',exact:true}).click();const slider=page.getByLabel('近景裁剪');await slider.focus();for(let i=0;i<15;i++)await page.keyboard.press('ArrowRight');
  await page.getByRole('button',{name:'关闭设置'}).click();await page.getByRole('button',{name:/^观察/}).first().click();
  const canvas=page.locator('canvas'),rect=await canvas.boundingBox();
  async function collapse(){return await page.evaluate(()=>{const {camera,controls}=window.__pointEditTesting;const forward=camera.position.clone();camera.getWorldDirection(forward);controls.target.copy(camera.position).addScaledVector(forward,.01);controls.update();return camera.position.distanceTo(controls.target);});}
  assert.ok(await collapse()<.02);await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
  await page.mouse.wheel(0,-120);
  const afterWheel=await page.evaluate(()=>{const {camera,controls}=window.__pointEditTesting;return camera.position.distanceTo(controls.target)});
  assert.ok(afterWheel>.1,`缩放应恢复有效距离，得到 ${afterWheel}`);
  assert.ok(await collapse()<.02);const before=await page.evaluate(()=>window.__pointEditTesting.camera.position.toArray());
  await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down({button:'right'});await page.mouse.move(rect.x+rect.width/2+100,rect.y+rect.height/2,{steps:8});await page.mouse.up({button:'right'});
  const result=await page.evaluate(()=>{const {camera,controls}=window.__pointEditTesting;return {distance:camera.position.distanceTo(controls.target),position:camera.position.toArray()}});
  assert.ok(result.distance>.1,'平移应先恢复有效距离');assert.ok(Math.hypot(...result.position.map((n,i)=>n-before[i]))>.01,'右键拖动应实际平移');
  if(process.env.POINT_EDIT_TEST_GLB){await page.evaluate(()=>{const {camera,controls}=window.__pointEditTesting;const f=camera.position.clone();camera.getWorldDirection(f);controls.target.copy(camera.position).addScaledVector(f,.5);controls.update();});await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down({button:'right'});await page.mouse.move(rect.x+rect.width/2+100,rect.y+rect.height/2,{steps:8});await page.mouse.up({button:'right'});const distance=await page.evaluate(()=>window.__pointEditTesting.camera.position.distanceTo(window.__pointEditTesting.controls.target));assert.ok(distance>1,'大场景视距偏离时应恢复平移尺度');console.log('LARGE_SCENE_PIVOT_OK',distance);}
  console.log('PIVOT_NAVIGATION_REAL_BROWSER_OK');
 } finally {await browser.close();await server.close();}
} finally {blender.kill();}
