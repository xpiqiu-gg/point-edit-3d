import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { installC4dPlugin, rollbackC4dPlugin } from './scene-c4d.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'pe3d-install-'));
const source = path.join(temp, 'source');
const target = path.join(temp, 'maxon', 'Cinema4D_TEST', 'plugins');
await (async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'a.txt'), 'A1');
  await writeFile(path.join(source, 'b.txt'), 'B1');
})();

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`[install] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// 1) create into a missing target directory
let result = await installC4dPlugin({ sourceDirectory: source, targetDirectory: target, files: ['a.txt', 'b.txt'] });
check('目标目录不存在时自动创建并复制', result.files.every(file => file.action === 'created') && (await readFile(path.join(target, 'a.txt'), 'utf8')) === 'A1', JSON.stringify(result.files));

// 2) rerun -> unchanged
result = await installC4dPlugin({ sourceDirectory: source, targetDirectory: target, files: ['a.txt', 'b.txt'] });
check('内容一致时不重复写入', result.files.every(file => file.action === 'unchanged'), JSON.stringify(result.files));

// 3) changed target -> backup + replace
await writeFile(path.join(target, 'b.txt'), 'OLD');
result = await installC4dPlugin({ sourceDirectory: source, targetDirectory: target, files: ['a.txt', 'b.txt'] });
const replaced = result.files.find(file => file.name === 'b.txt');
check('不同内容先备份再替换', replaced?.action === 'replaced' && !!replaced.backup && (await readFile(replaced.backup, 'utf8')) === 'OLD' && (await readFile(path.join(target, 'b.txt'), 'utf8')) === 'B1', JSON.stringify(result.files));

// 4) rollback: replacement restores the old file; a fresh install removes created files
const rollback = await rollbackC4dPlugin({ targetDirectory: target, files: result.files });
const aStillThere = await stat(path.join(target, 'a.txt')).then(() => true).catch(() => false);
check('回滚恢复被替换文件（未改动文件保持原样）', rollback.files.some(file => file.name === 'b.txt' && file.action === 'restored') && aStillThere && (await readFile(path.join(target, 'b.txt'), 'utf8')) === 'OLD', JSON.stringify(rollback.files));

const freshTarget = path.join(temp, 'maxon3', 'Cinema4D_TEST', 'plugins');
const fresh = await installC4dPlugin({ sourceDirectory: source, targetDirectory: freshTarget, files: ['a.txt', 'b.txt'] });
const freshRollback = await rollbackC4dPlugin({ targetDirectory: freshTarget, files: fresh.files });
const freshRemaining = await readdir(freshTarget).catch(() => []);
check('回滚删除本次新建的文件', fresh.files.every(file => file.action === 'created') && freshRollback.files.every(file => file.action === 'removed') && freshRemaining.length === 0, JSON.stringify(freshRemaining));

// 5) missing source
result = await installC4dPlugin({ sourceDirectory: source, targetDirectory: target, files: ['a.txt', 'missing.txt'] });
check('缺少源文件时明确标记', result.files.find(file => file.name === 'missing.txt')?.action === 'missing_source', JSON.stringify(result.files));

// 6) real bundled C4D files
const bundled = path.resolve('..', 'c4d_plugin');
const realTarget = path.join(temp, 'maxon2', 'Cinema4D_TEST', 'plugins');
const real = await installC4dPlugin({ sourceDirectory: bundled, targetDirectory: realTarget });
const hashes = [];
for (const file of real.files) {
  const [sourceText, targetText] = await Promise.all([readFile(path.join(bundled, file.name)), readFile(path.join(realTarget, file.name))]);
  hashes.push({ name: file.name, action: file.action, same: sourceText.equals(targetText) });
}
check('随包 C4D 插件可完整复制', real.files.length >= 2 && hashes.every(item => item.same), JSON.stringify(hashes));
const realRollback = await rollbackC4dPlugin({ targetDirectory: realTarget, files: real.files });
const remaining = await readdir(realTarget);
check('随包插件可完整回滚', realRollback.files.length === real.files.length && remaining.length === 0, JSON.stringify(remaining));

await rm(temp, { recursive: true, force: true });
const failed = results.filter(item => !item.ok).length;
console.log(`[install] ${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
