import importlib.util

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
script = r"""
journalctl -u sunomaster -n 40 --no-pager
echo '---'
curl -sS -m 8 -H 'Host: 43.156.58.64' http://127.0.0.1/api/charts | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const d=JSON.parse(s); const pulses=d.pulses||[]; const q=pulses.find(p=>p.platform==="qishui"||p.label==="汽水"); const rising=(d.risingSongs||[]).filter(x=>x.platform==="qishui").slice(0,3).map(x=>x.songName); const fresh=(d.newSongs||[]).filter(x=>(x.platforms||[]).some(p=>p.platform==="qishui")).slice(0,3).map(x=>x.songName); const groups=(d.groups||[]).map(g=>g.label); console.log(JSON.stringify({q,rising,fresh,groups,pending:d.pending}));});'
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=25)
print(out)
print(err)
print("exit", code)
client.close()
