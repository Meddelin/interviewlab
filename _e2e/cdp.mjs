// CDP driver for the REAL Tauri WebView2 app (remote-debug :9222).
// Usage:
//   node cdp.mjs info                 -> list page targets
//   node cdp.mjs eval "<js expr>"     -> evaluate (awaitPromise) + collect console errors/exceptions
//   node cdp.mjs shot <path.png>      -> screenshot the app webview
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WS {
  constructor(s){this.sock=s;this.buf=Buffer.alloc(0);this.waiters=[];this.sock.on("data",d=>this._d(d));}
  static async connect(u0){const u=new URL(u0);const key=crypto.randomBytes(16).toString("base64");
    const sock=net.connect(Number(u.port),u.hostname);
    await new Promise((res,rej)=>{sock.once("connect",res);sock.once("error",rej);});
    sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await new Promise((res,rej)=>{let acc=Buffer.alloc(0);const on=d=>{acc=Buffer.concat([acc,d]);const i=acc.indexOf("\r\n\r\n");if(i!==-1){sock.removeListener("data",on);const left=acc.slice(i+4);res();if(left.length)sock.emit("data",left);}};sock.on("data",on);sock.once("error",rej);});
    return new WS(sock);}
  _d(d){this.buf=Buffer.concat([this.buf,d]);let f;while((f=this._rf())!==null){const w=this.waiters.shift();if(w)w(f);else (this._pend=this._pend||[]).push(f);}}
  _rf(){if(this.buf.length<2)return null;const b1=this.buf[1];const op=this.buf[0]&0x0f;let len=b1&0x7f;let off=2;
    if(len===126){if(this.buf.length<4)return null;len=this.buf.readUInt16BE(2);off=4;}else if(len===127){if(this.buf.length<10)return null;len=Number(this.buf.readBigUInt64BE(2));off=10;}
    if(this.buf.length<off+len)return null;const p=this.buf.slice(off,off+len);this.buf=this.buf.slice(off+len);return{op,p};}
  _recv(){if(this._pend&&this._pend.length)return Promise.resolve(this._pend.shift());return new Promise(r=>this.waiters.push(r));}
  async recvText(){for(;;){const f=await this._recv();if(f.op===0x9){this._s(0xa,f.p);continue;}if(f.op===0x8)throw new Error("ws closed");return f.p.toString("utf8");}}
  _s(op,pl){const m=crypto.randomBytes(4);const len=pl.length;let h;if(len<126){h=Buffer.alloc(2);h[1]=0x80|len;}else if(len<65536){h=Buffer.alloc(4);h[1]=0x80|126;h.writeUInt16BE(len,2);}else{h=Buffer.alloc(10);h[1]=0x80|127;h.writeBigUInt64BE(BigInt(len),2);}h[0]=0x80|op;const mk=Buffer.from(pl);for(let i=0;i<mk.length;i++)mk[i]^=m[i%4];this.sock.write(Buffer.concat([h,m,mk]));}
  sendText(s){this._s(0x1,Buffer.from(s,"utf8"));}
}
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];this._loop();}
  async _loop(){for(;;){let m;try{m=await this.ws.recvText();}catch{return;}const o=JSON.parse(m);
    if(o.id&&this.pending.has(o.id)){const{res,rej}=this.pending.get(o.id);this.pending.delete(o.id);o.error?rej(new Error(JSON.stringify(o.error))):res(o.result);}
    else if(o.method){this.events.push(o);}}}
  send(method,params={}){const id=++this.id;this.ws.sendText(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}));}
}
function getJSON(u){return new Promise((res,rej)=>{http.get(u,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));}).on("error",rej);});}

async function pageTarget(){
  const list=await getJSON(`http://localhost:${PORT}/json/list`);
  // the app page: type 'page', url is the app (localhost:1420 or tauri://). Skip devtools/extensions.
  const cands=list.filter(t=>t.type==="page"&&!/devtools|chrome-extension/.test(t.url));
  const app=cands.find(t=>/localhost:1420|tauri|index\.html/i.test(t.url))||cands[0];
  return {app, all:list};
}

async function main(){
  const mode=process.argv[2];
  if(mode==="info"){
    const {all}=await pageTarget();
    for(const t of all) console.log(`[${t.type}] ${t.title} :: ${t.url}`);
    process.exit(0);
  }
  const {app}=await pageTarget();
  if(!app){console.error("NO PAGE TARGET — is the app up?");process.exit(2);}
  const ws=await WS.connect(app.webSocketDebuggerUrl);
  const page=new CDP(ws);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Log.enable").catch(()=>{});

  if(mode==="shot"){
    const out=process.argv[3];
    const {data}=await page.send("Page.captureScreenshot",{format:"png",fromSurface:true});
    fs.writeFileSync(out,Buffer.from(data,"base64"));
    console.log("saved "+out);
    process.exit(0);
  }
  if(mode==="eval"){
    const expr=process.argv[3];
    page.events.length=0; // reset
    let out;
    try{
      const {result,exceptionDetails}=await page.send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
      out=exceptionDetails?{evalError:JSON.stringify(exceptionDetails).slice(0,600)}:{value:result.value};
    }catch(e){out={callError:String(e).slice(0,400)};}
    await sleep(350); // drain console/exception events
    const errs=page.events.filter(e=>e.method==="Runtime.consoleAPICalled"&&/error|warning/.test(e.params.type))
      .map(e=>({t:e.params.type,m:(e.params.args||[]).map(a=>a.value??a.description??a.type).join(" ").slice(0,200)}));
    const exc=page.events.filter(e=>e.method==="Runtime.exceptionThrown")
      .map(e=>(e.params.exceptionDetails?.exception?.description||e.params.exceptionDetails?.text||"").slice(0,250));
    console.log(JSON.stringify({...out, consoleErrors:errs, exceptions:exc},null,1));
    process.exit(0);
  }
  console.error("unknown mode");process.exit(1);
}
main().catch(e=>{console.error("DRIVER FAIL:",String(e).slice(0,400));process.exit(1);});
