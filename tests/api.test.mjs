import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleApi,identity,provinces,DAILY_OFFER_LIMIT} from '../worker/api.mjs';

const origin='https://baraka.test';
function setup(){const store=new Map();return{ADMIN_EMAIL:'admin@example.com',store,BUCKET:{async put(k,v){store.set(k,v)},async get(k){const v=store.get(k);if(v===undefined)return null;return typeof v==='string'?{json:async()=>JSON.parse(v)}:{body:v}},async delete(k){store.delete(k)},async list({prefix}){return{objects:[...store.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false}}}}}

// A Firebase ID token for a Google account. `user` becomes the account id; tests use the email claim
// only to tell the fake Google lookup which email the account has.
function googleToken(claims={}){const payload={aud:'baraka-b01fa',iss:'https://securetoken.google.com/baraka-b01fa',sub:'firebase-user',firebase:{sign_in_provider:'google.com'},exp:Date.now()/1000+3600,...claims};return 'x.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.signature'}
const lookup=async(url,opts)=>{const c=JSON.parse(Buffer.from(JSON.parse(opts.body).idToken.split('.')[1],'base64url'));return Response.json({users:[{localId:c.sub,email:c.email||c.sub+'@example.com',emailVerified:true}]})};
function req(method,path,user,body,originHeader=origin,email){return new Request(origin+path,{method,headers:{'Content-Type':'application/json','Origin':originHeader,...(user?{Authorization:'Bearer '+googleToken({sub:user,...(email?{email}:{})})}:{})},...(body?{body:JSON.stringify(body)}:{})})}
const call=(r,env)=>handleApi(r,env,lookup);
const offer={title:'كتب',desc:'كتب بحالة جيدة',area:'المنصور',owner:'علي',cat:'كتب',city:'بغداد',price:0,phone:'07701234567',location:null};
async function create(env,user='alice',extra={},email){const r=await call(req('POST','/api/offers',user,{...offer,...extra},origin,email),env);assert.equal(r.status,201);return(await r.json()).offer}

test('all 19 governorates including Halabja accepted',async()=>{assert.equal(new Set(provinces).size,19);const env=setup();for(const city of provinces)await create(env,'admin',{city},'admin@example.com');assert.equal((await(await call(req('GET','/api/offers','alice'),env)).json()).offers.length,19)});

test('only owner or administrator can delete',async()=>{const env=setup(),x=await create(env);assert.equal((await call(req('DELETE','/api/offers/'+x.id,null),env)).status,401);assert.equal((await call(req('DELETE','/api/offers/'+x.id,'bob'),env)).status,403);assert.equal((await call(req('DELETE','/api/offers/'+x.id,'boss',undefined,origin,'admin@example.com'),env)).status,200);const y=await create(env);assert.equal((await call(req('DELETE','/api/offers/'+y.id,'alice'),env)).status,200)});

test('cannot forge ownership or administrator in request payload',async()=>{const env=setup(),x=await create(env,'alice',{ownerId:'bob',admin:true,canDelete:true});const data=await(await call(req('GET','/api/offers','bob'),env)).json();assert.equal(data.offers[0].canDelete,false);assert.equal(data.offers[0].mine,false);assert.equal('ownerId'in data.offers[0],false);assert.equal((await call(req('DELETE','/api/offers/'+x.id,'bob'),env)).status,403)});

test('platform identity headers no longer sign anyone in',async()=>{const env=setup(),x=await create(env);const forged=h=>new Request(origin+'/api/offers/'+x.id,{method:'DELETE',headers:{Origin:origin,'oai-authenticated-user-id':'anyone','oai-authenticated-user-email':'admin@example.com',...h}});assert.equal((await call(forged({}),env)).status,401);assert.equal(await identity(forged({}),env,lookup),null)});

test('anonymous and cross-origin mutations rejected',async()=>{const env=setup();assert.equal((await call(req('POST','/api/offers',null,offer),env)).status,401);assert.equal((await call(req('POST','/api/offers','alice',offer,'https://evil.test'),env)).status,403)});

test('phone, coordinates, province, food and images validated server side',async()=>{for(const extra of [{phone:'123'},{city:'غير موجود'},{location:{lat:'33',lng:44}},{location:{lat:91,lng:44}},{cat:'طعام',food:'',pickup:'2000-01-01'},{img:'https://example.com/a.svg'}])assert.equal((await call(req('POST','/api/offers','alice',{...offer,...extra}),setup())).status,400);await create(setup(),'alice',{location:{lat:33.3,lng:44.4}})});

test('empty shared store contains no demonstration offers',async()=>{const data=await(await call(req('GET','/api/offers','alice'),setup())).json();assert.deepEqual(data.offers,[]);assert.equal(data.user.admin,false);assert.equal(data.user.provider,'google')});

test('photos are stored and served separately from the offers list',async()=>{const env=setup(),jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);const x=await create(env,'alice',{img:'data:image/jpeg;base64,'+jpeg.toString('base64')});assert.equal(x.img,'/api/images/'+x.id);const list=await(await call(req('GET','/api/offers'),env)).text();assert.ok(!list.includes('base64'));const img=await call(req('GET','/api/images/'+x.id),env);assert.equal(img.status,200);assert.equal(img.headers.get('Content-Type'),'image/jpeg');assert.deepEqual(Buffer.from(await img.arrayBuffer()),jpeg);await call(req('DELETE','/api/offers/'+x.id,'alice'),env);assert.equal((await call(req('GET','/api/images/'+x.id),env)).status,404)});

test('photos inside older offers are still served from their own URL',async()=>{const env=setup(),id='11111111-2222-3333-4444-555555555555',jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);env.store.set('offers/'+id,JSON.stringify({...offer,id,ownerId:'old',img:'data:image/jpeg;base64,'+jpeg.toString('base64'),createdAt:'2025-01-01T00:00:00.000Z'}));const data=await(await call(req('GET','/api/offers'),env)).json();assert.equal(data.offers[0].img,'/api/images/'+id);assert.deepEqual(Buffer.from(await(await call(req('GET','/api/images/'+id),env)).arrayBuffer()),jpeg)});

test('daily offer limit per account, administrator exempt',async()=>{const env=setup();for(let i=0;i<DAILY_OFFER_LIMIT;i++)await create(env);assert.equal((await call(req('POST','/api/offers','alice',offer),env)).status,429);await create(env,'bob');for(let i=0;i<DAILY_OFFER_LIMIT+1;i++)await create(env,'boss',{},'admin@example.com')});

test('Firebase token is checked with Google before ownership is granted',async()=>{let called=false;const user=await identity(req('GET','/api/offers','firebase-user'),setup(),async(url,opts)=>{called=true;assert.ok(url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup?'));assert.ok(JSON.parse(opts.body).idToken);return Response.json({users:[{localId:'firebase-user',email:'alice@example.com',emailVerified:true}]})});assert.ok(called);assert.equal(user.id,'firebase:firebase-user');assert.equal(user.admin,false)});

test('unverified administrator email has no admin access',async()=>{for(const verified of [false,true]){const user=await identity(req('GET','/api/offers','firebase-user'),setup(),async()=>Response.json({users:[{localId:'firebase-user',email:'admin@example.com',emailVerified:verified}]}));assert.equal(user.admin,verified)}});

test('invalid, expired, wrong-project and mismatched tokens fail closed',async()=>{const tok=c=>new Request(origin+'/api/offers',{headers:{Authorization:'Bearer '+googleToken(c)}});assert.equal(await identity(tok(),setup(),async()=>Response.json({error:'INVALID_ID_TOKEN'},{status:400})),null);for(const claims of [{aud:'other-project'},{iss:'https://evil.test'},{exp:1},{firebase:{sign_in_provider:'password'}}])assert.equal(await identity(tok(claims),setup(),()=>{throw Error('must reject before lookup')}),null);assert.equal(await identity(tok(),setup(),async()=>Response.json({users:[{localId:'different-user'}]})),null)});

test('Google lookup outage keeps public browsing available but blocks changes',async()=>{const env=setup(),down=async()=>{throw Error('network down')};const list=await handleApi(req('GET','/api/offers','alice'),env,down);assert.equal(list.status,200);assert.equal((await list.json()).user,null);assert.equal((await handleApi(req('POST','/api/offers','alice',offer),env,down)).status,500)});
