export const provinces=['بغداد','البصرة','نينوى','أربيل','النجف','كربلاء','كركوك','الأنبار','بابل','ديالى','ذي قار','السليمانية','صلاح الدين','دهوك','القادسية','المثنى','ميسان','واسط','حلبجة'];
export const DAILY_OFFER_LIMIT=10;
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const FIREBASE_PROJECT='baraka-b01fa';
const FIREBASE_KEY='AIzaSyD3sNbaR7ULiZRr9PW6fao2xEEVZyLHmZ0';
const ID=/^[0-9a-f-]{36}$/;

// Sign-in is by Google account only, through Firebase. Platform identity headers are ignored,
// so nobody can claim an account (or the administrator email) by setting request headers.
export async function identity(request,env,fetcher=fetch){
 const header=request.headers.get('Authorization');
 if(!header||!header.startsWith('Bearer ')||header.length>10000)return null;
 const token=header.slice(7);let claims;
 try{const encoded=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');claims=JSON.parse(atob(encoded));}catch{return null}
 if(claims.aud!==FIREBASE_PROJECT||claims.iss!=='https://securetoken.google.com/'+FIREBASE_PROJECT||typeof claims.sub!=='string'||!claims.sub||typeof claims.exp!=='number'||claims.exp<=Date.now()/1000)return null;
 if(claims.firebase?.sign_in_provider!=='google.com')return null;
 // Google verifies the token, its signature, and current account state. Never trust decoded claims alone.
 const response=await fetcher('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+FIREBASE_KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)return null;
 const data=await response.json(),account=data.users?.[0];
 if(!account||account.disabled||account.localId!==claims.sub)return null;
 const email=account.email||'',verified=account.emailVerified===true;
 return{id:'firebase:'+account.localId,email,verified,provider:'google',admin:!!env.ADMIN_EMAIL&&verified&&email.toLowerCase()===env.ADMIN_EMAIL.toLowerCase()};
}

function present(x,user){
 const {ownerId,...data}=x;
 // Photos are served from their own URL so the offers list stays small.
 const img=x.img?(x.img.startsWith('data:')?'/api/images/'+x.id:x.img):'';
 return {...data,img,mine:!!user&&ownerId===user.id,canDelete:!!user&&(user.admin||ownerId===user.id),urgent:x.cat==='طعام'&&new Date(x.pickup)>new Date()&&new Date(x.pickup)-Date.now()<86400000};
}

function validate(d){
 if(!d||typeof d!=='object')return 'بيانات غير صحيحة';
 for(const [k,max] of [['title',70],['area',60],['owner',45],['desc',700]])if(typeof d[k]!=='string'||!d[k].trim()||d[k].length>max)return 'أكمل حقول العرض بشكل صحيح';
 if(!provinces.includes(d.city)||!['طعام','ملابس','أثاث','كتب'].includes(d.cat))return 'المحافظة أو القسم غير صحيح';
 if(!Number.isInteger(d.price)||d.price<0||d.price>10000000)return 'السعر غير صحيح';
 if(typeof d.phone!=='string'||!/^(?:07\d{9}|\+9647\d{9}|009647\d{9})$/.test(d.phone))return 'رقم الهاتف غير صحيح';
 if(d.img&&(typeof d.img!=='string'||d.img.length>1000000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(d.img)))return 'صورة غير صالحة أو كبيرة جداً';
 if(d.location!==null&&d.location!==undefined){const p=d.location;if(typeof p!=='object'||typeof p.lat!=='number'||typeof p.lng!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180)return 'إحداثيات غير صحيحة'}
 if(d.cat==='طعام'&&(typeof d.food!=='string'||!d.food.trim()||d.food.length>700||typeof d.pickup!=='string'||!Number.isFinite(Date.parse(d.pickup))||Date.parse(d.pickup)<=Date.now()))return 'أكمل معلومات الطعام وموعد الاستلام';
 return null;
}

const bytes=dataUrl=>Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',')+1)),c=>c.charCodeAt(0));
const imageResponse=body=>new Response(body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}});

export async function handleApi(request,env,fetcher=fetch){
 const url=new URL(request.url);
 try{
  if(!env.BUCKET)return json({error:'خدمة التخزين غير متاحة حالياً. حاول لاحقاً.'},503);

  if(request.method==='GET'&&/^\/api\/images\/[0-9a-f-]{36}$/.test(url.pathname)){
   const id=url.pathname.split('/').pop();
   const stored=await env.BUCKET.get('images/'+id);
   if(stored)return imageResponse(stored.body??await stored.arrayBuffer());
   // Offers published before photos were stored separately keep the photo inside the offer.
   const object=await env.BUCKET.get('offers/'+id);const offer=object&&await object.json();
   if(offer?.img?.startsWith('data:image/jpeg;base64,'))return imageResponse(bytes(offer.img));
   return new Response('Not found',{status:404});
  }

  let user;
  try{user=await identity(request,env,fetcher)}catch(e){if(request.method!=='GET')throw e;user=null}

  if(request.method==='GET'&&url.pathname==='/api/offers'){
   const offers=[];let cursor;
   do{const page=await env.BUCKET.list({prefix:'offers/',limit:1000,...(cursor?{cursor}:{})});const rows=await Promise.all(page.objects.map(x=>env.BUCKET.get(x.key)));for(const row of rows)if(row)offers.push(present(await row.json(),user));cursor=page.truncated?page.cursor:undefined}while(cursor);
   offers.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
   return json({offers,user:user?{admin:user.admin,email:user.email,verified:user.verified,provider:user.provider}:null});
  }
  if(!['POST','DELETE'].includes(request.method))return json({error:'غير موجود'},404);
  if(!user)return json({error:'سجّل دخولك بحساب Google أولاً'},401);
  if(request.headers.get('Origin')!==url.origin)return json({error:'طلب غير مسموح'},403);

  if(request.method==='POST'&&url.pathname==='/api/offers'){
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'نوع الطلب غير صحيح'},415);
   if(Number(request.headers.get('Content-Length'))>1100000)return json({error:'الصورة كبيرة جداً'},413);
   const text=await request.text();if(text.length>1100000)return json({error:'الصورة كبيرة جداً'},413);
   let d;try{d=JSON.parse(text)}catch{return json({error:'بيانات غير صحيحة'},400)}
   const error=validate(d);if(error)return json({error},400);
   // Limit how many offers one account can publish per day (the administrator is exempt).
   const limitKey='limits/'+user.id,now=Date.now();
   const limitObject=await env.BUCKET.get(limitKey);
   const recent=((limitObject&&(await limitObject.json()).times)||[]).filter(t=>now-Date.parse(t)<86400000);
   if(!user.admin&&recent.length>=DAILY_OFFER_LIMIT)return json({error:'وصلت للحد اليومي ('+DAILY_OFFER_LIMIT+' عروض). حاول باچر.'},429);
   const id=crypto.randomUUID();
   if(d.img)await env.BUCKET.put('images/'+id,bytes(d.img),{httpMetadata:{contentType:'image/jpeg'}});
   const offer={id,ownerId:user.id,title:d.title.trim(),area:d.area.trim(),owner:d.owner.trim(),desc:d.desc.trim(),cat:d.cat,city:d.city,price:d.price,phone:d.phone,img:d.img?'/api/images/'+id:'',location:d.location?{lat:d.location.lat,lng:d.location.lng}:null,food:d.cat==='طعام'?d.food.trim():'',pickup:d.cat==='طعام'?new Date(d.pickup).toISOString():null,createdAt:new Date(now).toISOString()};
   await env.BUCKET.put('offers/'+id,JSON.stringify(offer),{httpMetadata:{contentType:'application/json'}});
   await env.BUCKET.put(limitKey,JSON.stringify({times:[...recent,offer.createdAt]}),{httpMetadata:{contentType:'application/json'}});
   return json({offer:present(offer,user)},201);
  }

  if(request.method==='DELETE'&&url.pathname.startsWith('/api/offers/')&&ID.test(url.pathname.slice(12))){
   const id=url.pathname.slice(12),key='offers/'+id;
   const object=await env.BUCKET.get(key);if(!object)return json({error:'العرض غير موجود'},404);
   const offer=await object.json();
   if(!user.admin&&offer.ownerId!==user.id)return json({error:'الحذف متاح لصاحب العرض والمدير فقط'},403);
   await env.BUCKET.delete(key);await env.BUCKET.delete('images/'+id);
   return json({ok:true});
  }
  return json({error:'غير موجود'},404);
 }catch{return json({error:'تعذر تنفيذ الطلب. حاول مرة ثانية.'},500)}
}
