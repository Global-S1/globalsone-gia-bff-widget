const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { demoRoutes } = require('../../build/src/api/routes/demo.routes');
const { trustedDemoProxies } = require('../../build/src/api/demo-proxy');

async function fixture(t, trust = false, tenant = "") {
 const seen = [];
 const upstream = express(); upstream.use(express.json());
 upstream.use((req,res) => { seen.push({path:req.path,headers:req.headers,body:req.body}); res.status(req.path.endsWith('/messages') ? 429 : 200).json({success:true,data:{ok:true}}); });
 const u = upstream.listen(0,'127.0.0.1'); await new Promise(r=>u.once('listening',r));
 const app=express(); app.set('trust proxy',trust); app.use(express.json());
 app.use('/v1/demo',demoRoutes({baseUrl:()=>`http://127.0.0.1:${u.address().port}`,internalToken:()=> 'server-secret',demoTenant:()=>tenant}));
 const s=app.listen(0,'127.0.0.1'); await new Promise(r=>s.once('listening',r));
 t.after(()=>{s.closeAllConnections();s.close();u.closeAllConnections();u.close();});
 return {seen,url:`http://127.0.0.1:${s.address().port}/v1/demo`};
}
const demo='12c2aa46-1023-482d-9f73-943f7454a0a2', session='43c2aa46-1023-482d-9f73-943f7454a0a2';
test('public facade strips spoofed tenant, IP and admin identity',async t=>{
 const {url,seen}=await fixture(t);
 const res=await fetch(`${url}/${demo}/sessions`,{method:'POST',headers:{'Content-Type':'application/json','x-demo-ip':'1.2.3.4','ip-address':'4.3.2.1','x-forwarded-for':'8.8.8.8','x-user-role':'SuperAdmin','x-internal-token':'attacker'},body:JSON.stringify({requestId:session,tenantId:'other',ipAddress:'6.6.6.6'})});
 assert.equal(res.status,200);assert.equal(seen.length,1);
 assert.equal(seen[0].headers['x-demo-ip'],'127.0.0.1');assert.equal(seen[0].headers['x-internal-token'],'server-secret');assert.equal(seen[0].headers['x-user-role'],undefined);assert.deepEqual(seen[0].body,{requestId:session});
});
test('only explicit trusted proxy allows forwarding IP',async t=>{
 const {url,seen}=await fixture(t,['loopback']); await fetch(`${url}/${demo}`,{headers:{'x-forwarded-for':'203.0.113.1'}}); assert.equal(seen[0].headers['x-demo-ip'],'203.0.113.1');
});
test('unknown/admin paths never reach ms-agents',async t=>{
 const {url,seen}=await fixture(t);const res=await fetch(`${url}/admin/contacts`);assert.equal(res.status,404);assert.equal(seen.length,0);
});
test('session required and quota status/body preserved',async t=>{
 const {url,seen}=await fixture(t);assert.equal((await fetch(`${url}/${demo}/sessions/${session}`)).status,401);assert.equal(seen.length,0);
 const res=await fetch(`${url}/${demo}/sessions/${session}/messages`,{method:'POST',headers:{'Content-Type':'application/json','x-demo-session':'opaque-session-secret'},body:JSON.stringify({message:'Hola',requestId:demo})});assert.equal(res.status,429);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(seen[0].headers['x-demo-session'],'opaque-session-secret');assert.deepEqual(await res.json(),{success:true,data:{ok:true}});
});
test('proxy trust defaults closed and rejects blanket trust',()=>{
 assert.equal(trustedDemoProxies(undefined),false);assert.equal(trustedDemoProxies(''),false);assert.throws(()=>trustedDemoProxies('true'));assert.throws(()=>trustedDemoProxies('*'));assert.deepEqual(trustedDemoProxies('127.0.0.1, ::1'),['127.0.0.1','::1']);
});

test('catalog uses server tenant, ignores spoofed routing and fails closed without config',async t=>{
 const tenant='a9ed3533-e010-4709-82dc-1036808cd194';
 const {url,seen}=await fixture(t,false,tenant);
 const r=await fetch(`${url}/catalog?tenantId=attacker`,{headers:{'x-tenant-id':'attacker'}});
 assert.equal(r.status,200);assert.equal(seen[0].path,`/v1/demo/catalog/${tenant}`);
 const unconfigured=await fixture(t);assert.equal((await fetch(unconfigured.url+'/catalog')).status,503);assert.equal(unconfigured.seen.length,0);
});

test('public page resolves only the server tenant and ignores query agent overrides',async t=>{
 const tenant='a9ed3533-e010-4709-82dc-1036808cd194';const {url,seen}=await fixture(t,false,tenant);
 assert.equal((await fetch(`${url}/pages/asistencia-gremial?agent=attacker&tenantId=other`,{headers:{'x-organization-token':'other'}})).status,200);
 assert.equal(seen[0].path,`/v1/demo/pages/${tenant}/asistencia-gremial`);
 assert.equal(seen[0].headers['x-organization-token'],undefined);
 assert.equal((await fetch(`${url}/pages/bad%2Fpath`)).status,404);
 const unconfigured=await fixture(t);assert.equal((await fetch(unconfigured.url+'/pages/soft')).status,503);
});

test('public locale update requires a session and strips identity overrides', async t => {
 const {url,seen}=await fixture(t);
 const path=`${url}/${demo}/sessions/${session}/locale`;
 const body={conversationLocale:'pt-BR',agentId:'other',tenantId:'other'};
 assert.equal((await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
 assert.equal(seen.length,0);
 assert.equal((await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json','x-demo-session':'token'},body:JSON.stringify(body)})).status,200);
 assert.deepEqual(seen[0].body,{conversationLocale:'pt-BR'});
 assert.equal(seen[0].headers['x-demo-session'],'token');
});
