/* Uploads the xlsx skill dir + 3 user files + a skill tarball through the REAL file server
 * POST /sessions/:sid/objects (multipart, filename = `${fileId}___${relpath}`), writes manifest.json. */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { randomBytes } from 'crypto';

const FS = process.env.FS_URL ?? 'http://sb-fs:3000';
const TOKEN = 'benchtoken';
const SKILL_DIR = '/skill/xlsx';

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const id = () => randomBytes(10).toString('base64url').replace(/[-_]/g, 'x').slice(0, 21);

async function upload(sid: string, items: { name: string; data: Uint8Array }[], readOnly: boolean) {
  const fd = new FormData();
  const ids: { id: string; name: string; size: number }[] = [];
  for (const it of items) {
    const fid = id();
    ids.push({ id: fid, name: it.name, size: it.data.length });
    fd.append('file', new Blob([it.data]), encodeURIComponent(`${fid}___${it.name}`));
  }
  const res = await fetch(`${FS}/sessions/${sid}/objects`, {
    method: 'POST',
    body: fd,
    headers: { 'X-CodeAPI-Internal-Token': TOKEN, ...(readOnly ? { 'X-Read-Only': 'true' } : {}) },
  });
  const j = (await res.json()) as { files: unknown[] };
  if (j.files.length !== items.length) throw new Error(`uploaded ${j.files.length}/${items.length}`);
  return ids;
}

const skillFiles = walk(SKILL_DIR).map((p) => ({ name: 'xlsx/' + relative(SKILL_DIR, p), data: readFileSync(p) }));
const skill = await upload('skillsess0000000000001', skillFiles, true);
const userFiles = [1, 2, 3].map((i) => ({ name: `user${i}.csv`, data: randomBytes(50 * 1024) }));
const user = await upload('usersess00000000000001', userFiles, false);
const tar = await upload('skillsess0000000000001', [{ name: 'xlsx.tar.gz', data: readFileSync('/bench/xlsx.tar.gz') }], true);
writeFileSync('/bench/manifest.json', JSON.stringify({ skill, user, tar: tar[0] }, null, 1));
console.log(`skill=${skill.length} files ${skill.reduce((a, b) => a + b.size, 0)} B; user=${user.length}; tar=${tar[0].size} B`);
