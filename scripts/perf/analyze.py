import json,sys,subprocess,statistics as st
R=sys.argv[1]; tags=sys.argv[2].split(',') ; name=sys.argv[3] if len(sys.argv)>3 else 'rb-runner'
logs=subprocess.run(['docker','logs',name],capture_output=True,text=True).stdout+subprocess.run(['docker','logs',name],capture_output=True,text=True).stderr
ph={}
for l in logs.splitlines():
    if '"PHASES"' in l:
        j=json.loads(l); ph[j['job']]=j
cl=[json.loads(l) for l in open(R+'/bench/client.jsonl') if l.strip()]
def q(v,p): v=sorted(v); return v[min(len(v)-1,int(p*len(v)))]
keys=['body_parse','validate_getjob','prime','execute','upload','respond','cleanup','total_handler']
sub=['acquire_uid','create_ws','dirkeep_list','download_files','bash_extras','nsj_prep','gate_wait','spawn_to_marker','marker_to_exit','post_exec','walk_outputs','rm_ws']
for tag in tags:
  for sc in 'abcdef':
    rows=[c for c in cl if c['tag']==tag and c['scen']==sc]
    if not rows: continue
    ms=[c['ms'] for c in rows]; wall=[c['wall'] for c in rows if c['wall'] is not None]
    P=[ph[c['id']] for c in rows if c['id'] in ph]
    print(f"== {tag} {sc} n={len(rows)} client med={q(ms,.5):.0f} p90={q(ms,.9):.0f}  code_wall med={q(wall,.5)}  overhead(client-wall) med={q([c['ms']-(c['wall'] or 0) for c in rows],.5):.0f} p90={q([c['ms']-(c['wall'] or 0) for c in rows],.9):.0f}")
    if P:
      print('   top :', ' '.join(f"{k}={q([p['phases'].get(k,0) for p in P],.5):.1f}/{q([p['phases'].get(k,0) for p in P],.9):.1f}" for k in keys))
      print('   sub :', ' '.join(f"{k}={q([p['sub'].get(k,0) for p in P],.5):.1f}/{q([p['sub'].get(k,0) for p in P],.9):.1f}" for k in sub))
