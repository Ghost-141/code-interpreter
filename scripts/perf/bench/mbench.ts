import fs from 'fs';
import crypto from 'crypto';
import { executionManifestBodySha256, signExecutionManifestWithPrivateKey, verifyExecutionManifestWithPublicKey } from '/src/execution-manifest';
const m = JSON.parse(fs.readFileSync('/bench/manifest.json', 'utf8'));
const body = { session_id: 'x', language: 'bash', version: '5.2.0', files: [{ name: 'main.sh', content: 'true' }, ...m.skill.map((f: any) => ({ id: f.id, storage_session_id: 's', name: f.name }))] };
const N = 200; let t = performance.now();
for (let i = 0; i < N; i++) executionManifestBodySha256(body);
console.log('bodySha256 ms/op', ((performance.now() - t) / N).toFixed(3));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pk = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const now = Math.floor(Date.now() / 1000);
const claims: any = { v: 1, iat: now, exp: now + 300, execute_body_sha256: executionManifestBodySha256(body), input_files: body.files.slice(1).map((f: any) => ({ session_id: 's', id: f.id, name: f.name })) };
let tok: string; try { tok = signExecutionManifestWithPrivateKey(claims, pk); } catch (e) { console.log('sign err', (e as Error).message); process.exit(0); }
t = performance.now();
for (let i = 0; i < N; i++) { try { verifyExecutionManifestWithPublicKey(tok, pub, {} as any); } catch (e) { if (i === 0) console.log('verify err', (e as Error).message); } }
console.log('verify ms/op', ((performance.now() - t) / N).toFixed(3), 'token bytes', tok.length);
