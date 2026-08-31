// Verifica multi-turno: dos session/prompt sobre la MISMA sesión ACP.
import { spawn } from "node:child_process";
const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CWD = process.env.ACP_CWD ?? "/root";

const child = spawn("ssh", ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=30", BOX, "goose-acp"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "", nextId = 1; const pending = new Map();
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
function request(method, params){ const id=nextId++; send({jsonrpc:"2.0",id,method,params}); return new Promise((res,rej)=>pending.set(id,{res,rej})); }
function handle(msg){
  if (msg.id !== undefined && !msg.method){ const w=pending.get(msg.id); pending.delete(msg.id); if(msg.error) w?.rej(new Error(JSON.stringify(msg.error))); else w?.res(msg.result); return; }
  if (msg.method==="session/update"){ const u=msg.params?.update??{}; if(u.sessionUpdate==="agent_message_chunk") process.stdout.write(u.content?.text??""); return; }
  if (msg.method==="session/request_permission"){ const o=msg.params?.options??[]; const a=o.find(x=>x.kind==="allow_once")??o[0]; send({jsonrpc:"2.0",id:msg.id,result:{outcome:{outcome:"selected",optionId:a?.optionId}}}); return; }
  if (msg.method && msg.id !== undefined) send({jsonrpc:"2.0",id:msg.id,result:{}});
}
child.stdout.on("data",(c)=>{ buffer+=c; let nl; while((nl=buffer.indexOf("\n"))!==-1){ const l=buffer.slice(0,nl).trim(); buffer=buffer.slice(nl+1); if(!l)continue; try{handle(JSON.parse(l));}catch{} } });
child.on("exit",(code,sig)=>{ console.log(`\n[exit] ${code}`); process.exit(pending.size?2:0); });
const timeout = setTimeout(()=>{ console.error("\n[tmo]"); try{child.kill();}catch{}; process.exit(4); },180000);

(async()=>{
  const init = await request("initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}},clientInfo:{name:"multi",version:"1"}});
  const s = await request("session/new",{cwd:CWD,mcpServers:[]});
  const sid=s.sessionId; console.log(`sesión ${sid}`);
  for (const [i,text] of ["Escribe solo: TURNO_UNO","Escribe solo: TURNO_DOS"].entries()){
    process.stdout.write(`\n--- prompt ${i+1}: ${text} ---\n`);
    const r = await request("session/prompt",{sessionId:sid,prompt:[{type:"text",text}]});
    console.log(`\n[fin prompt ${i+1}] stop=${r.stopReason}`);
  }
  clearTimeout(timeout); try{child.kill();}catch{}; process.exit(0);
})().catch(e=>{ console.error("\n[error]",e.message); clearTimeout(timeout); try{child.kill();}catch{}; process.exit(5); });
