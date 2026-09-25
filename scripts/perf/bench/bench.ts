/* Client-side latency bench for POST /api/v2/execute.
 * env: SCEN=a,b,c,d  REPS=12  TAG=label  URL=http://rb-runner:2000 */
import fs from 'fs';
const URL_ = process.env.URL ?? 'http://rb-runner:2000';
const REPS = Number(process.env.REPS ?? 12);
const TAG = process.env.TAG ?? 'run';
const m = JSON.parse(fs.readFileSync('/bench/manifest.json', 'utf8'));
const refs = [
  ...m.skill.map((f: any) => ({ id: f.id, storage_session_id: 'skillsess0000000000001', name: f.name })),
  ...m.user.map((f: any) => ({ id: f.id, storage_session_id: 'usersess00000000000001', name: f.name })),
];
type Scen = { key: string; code: string; files: boolean; conc: number };
const S: Record<string, Scen> = {
  a: { key: 'a', code: 'true', files: false, conc: 1 },
  b: { key: 'b', code: 'true', files: true, conc: 1 },
  c: { key: 'c', code: 'ls /mnt/data | wc -l', files: true, conc: 3 },
  d: { key: 'd', code: 'ls /mnt/data | wc -l', files: true, conc: 8 },
  e: { key: 'e', code: 'ls /mnt/data | wc -l', files: false, conc: 3 },
  f: { key: 'f', code: 'ls /mnt/data | wc -l', files: false, conc: 8 },
};
async function one(s: Scen, id: string) {
  const body = {
    session_id: id, language: 'bash', version: '5.2.0',
    files: [{ name: 'main.sh', content: s.code }, ...(s.files ? refs : [])],
  };
  const t = performance.now();
  const r = await fetch(`${URL_}/api/v2/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  const ms = performance.now() - t;
  if (r.status !== 200 || j.run?.code !== 0) console.error('ERR', r.status, JSON.stringify(j).slice(0, 300));
  return { id, ms, wall: j.run?.wall_time ?? null, nfiles: j.files?.length ?? 0, out: (j.run?.stdout ?? '').trim() };
}
const out: any[] = [];
for (const k of (process.env.SCEN ?? 'a,b').split(',')) {
  const s = S[k];
  await one(s, `${TAG}_${k}_warm_0`);
  for (let rep = 0; rep < REPS; rep++) {
    const res = await Promise.all(Array.from({ length: s.conc }, (_, i) => one(s, `${TAG}_${k}_${rep}_${i}`)));
    for (const x of res) out.push({ tag: TAG, scen: k, ...x });
    await new Promise(r => setTimeout(r, 150));
  }
  const ms = out.filter(x => x.scen === k && x.tag === TAG).map(x => x.ms).sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))].toFixed(0);
  const last = out[out.length - 1];
  console.log(`${TAG} ${k} conc=${s.conc} n=${ms.length} med=${q(0.5)} p90=${q(0.9)} max=${ms[ms.length-1].toFixed(0)} ms  wall=${last.wall} files_ret=${last.nfiles} out=${last.out}`);
}
fs.appendFileSync('/bench/client.jsonl', out.map(x => JSON.stringify(x)).join('\n') + '\n');
