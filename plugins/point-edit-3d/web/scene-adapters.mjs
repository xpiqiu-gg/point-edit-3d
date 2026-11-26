import net from 'node:net';

export function blenderCommand(type, params, port, timeout = 4000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({host:'127.0.0.1', port});
    let chunks = [], size = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolvePromise(value); };
    socket.setTimeout(timeout, () => finish(new Error('Blender 连接超时')));
    socket.on('error', () => finish(new Error('无法连接 Blender')));
    socket.on('connect', () => socket.write(JSON.stringify({type,params})));
    socket.on('data', chunk => {
      chunks.push(chunk); size += chunk.length;
      if (size > 512 * 1024 * 1024) return finish(new Error('Blender 回复超过 512 MB 内存限制'));
      if (chunk[chunk.length - 1] !== 125) return;
      try { const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); if (value.status !== 'success') return finish(new Error(value.message || 'Blender 命令失败')); finish(null, value.result); } catch (error) { if (!(error instanceof SyntaxError)) finish(error); }
    });
    socket.on('end', () => finish(new Error('Blender 连接已关闭')));
  });
}


export function createBlenderAdapter(port) {
  return { kind: 'blender', command: (type, params, timeout) => blenderCommand(type, params, port, timeout) };
}

// C4D 场景适配（连接、预览导出、身份与执行）在 scene-c4d.mjs 中实现。
