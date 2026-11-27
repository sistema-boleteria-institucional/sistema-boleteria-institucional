import {convenioDocx,convenioTexto,FIRMA_INST} from './convenio.js';import express from 'express';import {createClient} from '@libsql/client';import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';import jwt from 'jsonwebtoken';import cookieParser from 'cookie-parser';import rateLimit from 'express-rate-limit';import ExcelJS from 'exceljs';
const E=process.env,db=createClient({url:E.TURSO_URL,authToken:E.TURSO_TOKEN});
const q=async(sql,args=[])=>(await db.execute({sql,args})).rows.map(r=>({...r}));
/* Mayúsculas: SQLite solo pasa a mayúscula las letras sin tilde, por eso se hace acá (respeta Ñ y tildes) */
const up=s=>String(s??'').trim().toLocaleUpperCase('es-AR');
/* Fecha/hora de Argentina a partir de un CURRENT_TIMESTAMP de la base (que guarda UTC) */
const fmtAR=s=>{if(!s)return'';const d=new Date(String(s).replace(' ','T')+'Z');return isNaN(d)?'':d.toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',','')};
const SCHEMA=[`CREATE TABLE IF NOT EXISTS usuarios(id INTEGER PRIMARY KEY,nombre TEXT,usuario TEXT UNIQUE,clave_hash TEXT,rol TEXT CHECK(rol IN('ap','adm','super')),activo INTEGER DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS actividades(id INTEGER PRIMARY KEY,nombre TEXT,dias TEXT,horarios TEXT,arancel INTEGER,tipo TEXT,origen TEXT,estado TEXT DEFAULT 'activa',creado_por INTEGER)`,
`CREATE TABLE IF NOT EXISTS cupones(id INTEGER PRIMARY KEY,codigo TEXT UNIQUE,tipo TEXT CHECK(tipo IN('porcentaje','monto')),valor INTEGER,activo INTEGER DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS inscripciones(id INTEGER PRIMARY KEY,actividad_id INTEGER,nombre TEXT,dni TEXT,fecha_nac TEXT,es_menor INTEGER,tutor_nombre TEXT,mail TEXT,whatsapp TEXT,direccion TEXT,barrio TEXT,localidad TEXT,provincia TEXT,metodo_pago TEXT,cupon_id INTEGER,monto INTEGER,estado TEXT DEFAULT 'pendiente',origen TEXT DEFAULT 'ap',creado_por INTEGER,creado_en TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS eventos_puntuales(id INTEGER PRIMARY KEY,nombre TEXT,fecha TEXT,horario TEXT,asistentes INTEGER,artista TEXT,descripcion TEXT,monto INTEGER,creado_por INTEGER)`,
`CREATE TABLE IF NOT EXISTS auditoria(id INTEGER PRIMARY KEY,usuario TEXT,accion TEXT,entidad TEXT,entidad_id INTEGER,detalle TEXT,fecha TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT)`,
/* Contactos de personas cuya inscripción se eliminó: solo nombre completo, mail, contacto y localidad. Si era menor, los datos son los del tutor. */
`CREATE TABLE IF NOT EXISTS contactos_eliminados(id INTEGER PRIMARY KEY,clave TEXT UNIQUE,nombre TEXT,mail TEXT,whatsapp TEXT,localidad TEXT,es_tutor INTEGER DEFAULT 0,eliminado_por TEXT,eliminado_en TEXT DEFAULT CURRENT_TIMESTAMP)`];
await db.batch(SCHEMA);
await db.execute("UPDATE inscripciones SET estado='inscripto' WHERE estado='aprobado'"); // estados: solo pendiente | inscripto
for(const c of ['tallerista_nombre','tallerista_contacto','tallerista_dni','tallerista_cvu'])try{await db.execute(`ALTER TABLE actividades ADD COLUMN ${c} TEXT`)}catch{}
/* Actividades ya cargadas: nombre, período, días y tallerista en mayúsculas. */
try{for(const a of await q('SELECT id,nombre,periodo,dias,tallerista_nombre FROM actividades')){const n=[a.nombre,a.periodo,a.dias,a.tallerista_nombre].map(x=>x==null?x:up(x));if(n[0]!==a.nombre||n[1]!==a.periodo||n[2]!==a.dias||n[3]!==a.tallerista_nombre)await q('UPDATE actividades SET nombre=?,periodo=?,dias=?,tallerista_nombre=? WHERE id=?',[...n,a.id])}}catch(e){console.error('mayúsculas actividades',e.message)}
try{await db.execute('ALTER TABLE eventos_puntuales ADD COLUMN franjas TEXT')}catch{}
try{await db.execute('ALTER TABLE actividades ADD COLUMN periodo TEXT')}catch{}
await db.execute(`CREATE TABLE IF NOT EXISTS bordereaux(id INTEGER PRIMARY KEY,evento_id INTEGER UNIQUE,anio INTEGER,numero INTEGER,resolucion TEXT,hora_inicio TEXT,hora_cierre TEXT,actividad TEXT,produccion TEXT,cuit TEXT,telefono TEXT,domicilio TEXT,entradas TEXT,sadaic_pct REAL DEFAULT 10,argentores_pct REAL DEFAULT 10,ich_pct REAL DEFAULT 10,fecha_pago_ret TEXT,liq_fecha TEXT,liq_hora TEXT,interviene TEXT,total_recaudado REAL,total_publico INTEGER,total_invitados INTEGER,ret_sadaic REAL,ret_argentores REAL,ret_total REAL,para_ich REAL,para_productora REAL,creado_por TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(anio,numero))`);
await db.execute(`CREATE TABLE IF NOT EXISTS planillas_firma(id INTEGER PRIMARY KEY,token TEXT UNIQUE,actividad_id INTEGER,taller TEXT,tallerista TEXT,desde TEXT,hasta TEXT,datos TEXT,creado_por TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP,enviado_a TEXT,firma_nombre TEXT,firma_dni TEXT,firma_img TEXT,firma_fecha TEXT,firma_ip TEXT,firma_hash TEXT)`);
for(const c of ['firma_token','firma_nombre','firma_dni','firma_img','firma_fecha','firma_ip','firma_hash'])try{await db.execute(`ALTER TABLE bordereaux ADD COLUMN ${c} TEXT`)}catch{}
try{await db.execute('ALTER TABLE bordereaux ADD COLUMN firma_icch INTEGER DEFAULT 0')}catch{}
await db.execute('UPDATE bordereaux SET para_productora=ROUND(total_recaudado-ret_total-para_ich,2) WHERE ROUND(para_productora,2)!=ROUND(total_recaudado-ret_total-para_ich,2)'); // si quedó algún bordereaux guardado con otra fórmula, se recalcula lo de la productora
/* Una sola vez: lo que ya estaba cargado se pasa a mayúsculas (nombres, dirección, localidad, provincia, actividades y eventos) */
if(!(await q("SELECT 1 FROM meta WHERE k='mayusculas'")).length){
 const st=[],fix=(tabla,cols,rows)=>{for(const r of rows){const set=cols.filter(c=>r[c]!=null&&up(r[c])!==r[c]);if(set.length)st.push({sql:`UPDATE ${tabla} SET ${set.map(c=>c+'=?').join(',')} WHERE id=?`,args:[...set.map(c=>up(r[c])),r.id]})}};
 fix('inscripciones',['nombre','tutor_nombre','direccion','barrio','localidad','provincia'],await q('SELECT id,nombre,tutor_nombre,direccion,barrio,localidad,provincia FROM inscripciones'));
 fix('actividades',['nombre','tallerista_nombre'],await q('SELECT id,nombre,tallerista_nombre FROM actividades'));
 fix('eventos_puntuales',['nombre'],await q('SELECT id,nombre FROM eventos_puntuales'));
 for(let i=0;i<st.length;i+=200)await db.batch(st.slice(i,i+200),'write');
 await q("INSERT INTO meta(k,v) VALUES('mayusculas',?)",[new Date().toISOString()]);console.log(`Mayúsculas: ${st.length} registros convertidos`)}
if(!(await q('SELECT 1 FROM usuarios')).length&&E.ADMIN_PASS)await q('INSERT INTO usuarios(nombre,usuario,clave_hash,rol) VALUES(?,?,?,?)',['Administrador',E.ADMIN_USER||'admin',bcrypt.hashSync(E.ADMIN_PASS,10),'super']);
/* Rol «super»: acceso total + gestión de usuarios. Se migra la tabla (el CHECK viejo solo admitía ap/adm) y, si todavía no hay ningún super, se promueve a gogalarza (o, si no existe, al administrador inicial). */
{const [t]=await q("SELECT sql FROM sqlite_master WHERE type='table' AND name='usuarios'");
 if(t&&!/'super'/.test(t.sql)){await db.batch(['DROP TABLE IF EXISTS usuarios_old','ALTER TABLE usuarios RENAME TO usuarios_old',"CREATE TABLE usuarios(id INTEGER PRIMARY KEY,nombre TEXT,usuario TEXT UNIQUE,clave_hash TEXT,rol TEXT CHECK(rol IN('ap','adm','super')),activo INTEGER DEFAULT 1)",'INSERT INTO usuarios(id,nombre,usuario,clave_hash,rol,activo) SELECT id,nombre,usuario,clave_hash,rol,activo FROM usuarios_old','DROP TABLE usuarios_old'],'write');console.log('Tabla usuarios actualizada (rol super)')}
 if(!(await q("SELECT 1 FROM usuarios WHERE rol='super' AND activo=1")).length){let [p]=await q("SELECT id,usuario FROM usuarios WHERE lower(usuario)='gogalarza'");if(!p)[p]=await q('SELECT id,usuario FROM usuarios WHERE lower(usuario)=lower(?)',[E.ADMIN_USER||'admin']);
  if(p){await q("UPDATE usuarios SET rol='super',activo=1 WHERE id=?",[p.id]);console.log('Usuario super:',p.usuario)}else console.warn('No hay ningún usuario super y no se encontró a quién promover')}}

const app=express();app.set('trust proxy',1);app.use('/api/firma',express.json({limit:'3mb'}));app.use('/api/planilla-firma',express.json({limit:'3mb'}));app.use('/api/convenio-firma',express.json({limit:'3mb'}));app.use('/api/argentores-firma',express.json({limit:'3mb'}));app.use(express.json(),cookieParser(),express.static('public'));
const audit=(u,accion,entidad,id,detalle='')=>q('INSERT INTO auditoria(usuario,accion,entidad,entidad_id,detalle) VALUES(?,?,?,?,?)',[u,accion,entidad,id,detalle]);
/* Sesión deslizante: vence a los 5 minutos sin pedidos al servidor; cada pedido la renueva */
const setSess=(res,u)=>res.cookie('t',jwt.sign({id:u.id,nombre:u.nombre,rol:u.rol},E.SESSION_SECRET,{expiresIn:'5m'}),{httpOnly:true,sameSite:'lax',secure:!!E.RENDER});
const auth=(...roles)=>(req,res,next)=>{try{req.u=jwt.verify(req.cookies.t,E.SESSION_SECRET);if(roles.length&&!roles.includes(req.u.rol))throw 0;setSess(res,req.u);next()}catch{res.status(401).json({error:'No autorizado'})}};
const ap=auth('ap','adm','super'),adm=auth('adm','super'),sup=auth('super');
const fail=(res,e)=>e&&e.status?res.status(e.status).json({error:e.error}):(console.error(e),res.status(500).json({error:'Error interno'}));
const wrap=f=>(req,res)=>f(req,res).catch(e=>fail(res,e));
const edad=f=>{const b=new Date(f),n=new Date();let a=n.getFullYear()-b.getFullYear();if(n<new Date(n.getFullYear(),b.getMonth(),b.getDate()))a--;return a};

/* Brevo */
async function mail(to,subject,html){if(!E.BREVO_API_KEY||!E.MAIL_FROM){console.warn('Mail NO enviado: falta BREVO_API_KEY o MAIL_FROM');return}
 try{const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':E.BREVO_API_KEY,'content-type':'application/json'},body:JSON.stringify({sender:{email:E.MAIL_FROM,name:'Inscripciones'},to:[{email:to}],subject,htmlContent:html})});
  if(!r.ok)console.error('Brevo rechazó el mail:',r.status,await r.text());else console.log('Mail enviado a',to)}catch(e){console.error('Error Brevo',e)}}

/* Login */
app.post('/api/login',rateLimit({windowMs:15*60e3,limit:20}),wrap(async(req,res)=>{
 const [u]=await q('SELECT * FROM usuarios WHERE usuario=? AND activo=1',[req.body.usuario]);
 if(!u||!bcrypt.compareSync(req.body.clave||'',u.clave_hash))return res.status(401).json({error:'Usuario o clave incorrectos'});
 setSess(res,u);res.json({id:u.id,nombre:u.nombre,rol:u.rol})}));
app.post('/api/logout',(req,res)=>res.clearCookie('t').json({ok:1}));
app.get('/api/yo',auth(),(req,res)=>res.json(req.u));

/* Actividades */
app.get('/api/actividades',ap,wrap(async(req,res)=>{const cols=req.u.rol!='ap'?'*':'id,nombre,periodo,dias,horarios,arancel,tipo,origen,estado';const rows=await q(`SELECT ${cols} FROM actividades`);res.json(rows.sort((x,y)=>String(x.nombre).localeCompare(String(y.nombre),'es',{sensitivity:'base',numeric:true})||y.id-x.id))}));
const txtc=(v,max=200)=>String(v??'').trim().slice(0,max);
/* El período (ej. "Marzo a julio 2026") solo lo ven los usuarios con sesión: no va en la web pública ni en los mails */
app.post('/api/actividades',adm,wrap(async(req,res)=>{const a=req.body,nombre=up(txtc(a.nombre));
 if(!nombre)return res.status(400).json({error:'Falta el nombre de la actividad'});
 if(!a.tallerista_nombre||!a.tallerista_contacto)return res.status(400).json({error:'Completá nombre completo y contacto del tallerista'});
 const ar=a.arancel===''||a.arancel==null?0:Number(a.arancel);if(!Number.isFinite(ar)||ar<0)return res.status(400).json({error:'El arancel tiene que ser un número de 0 o más'});
 const r=await db.execute({sql:'INSERT INTO actividades(nombre,periodo,dias,horarios,arancel,tipo,origen,creado_por,tallerista_nombre,tallerista_contacto,tallerista_dni,tallerista_cvu) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',args:[nombre,up(txtc(a.periodo,100))||null,up(txtc(a.dias)),txtc(a.horarios),Math.round(ar),txtc(a.tipo,40),txtc(a.origen,20),req.u.id,up(txtc(a.tallerista_nombre)),txtc(a.tallerista_contacto),txtc(a.tallerista_dni,30)||null,txtc(a.tallerista_cvu,100)||null]});
 await audit(req.u.nombre,'crear','actividad',Number(r.lastInsertRowid),nombre);res.json({ok:1})}));
/* Monto a pagar = arancel menos cupón (porcentaje o monto fijo). Lo usan las altas y el cambio de arancel de una actividad. */
const montoCon=(arancel,c)=>c?(c.tipo=='porcentaje'?Math.round(arancel*(1-c.valor/100)):Math.max(0,arancel-c.valor)):arancel;
app.patch('/api/actividades/:id',adm,wrap(async(req,res)=>{const b=req.body,id=+req.params.id;
 const [act0]=await q('SELECT arancel FROM actividades WHERE id=?',[id]);if(!act0)return res.sendStatus(404);
 if(b.estado!==undefined&&!['activa','suspendida'].includes(b.estado))return res.status(400).json({error:'Estado inválido'});
 const c={};
 if(b.nombre!==undefined){c.nombre=up(txtc(b.nombre));if(!c.nombre)return res.status(400).json({error:'Falta el nombre de la actividad'})}
 if(b.periodo!==undefined)c.periodo=up(txtc(b.periodo,100))||null;
 let nuevoAr=null;
 if(b.arancel!==undefined){const ar=b.arancel===''||b.arancel==null?NaN:Number(b.arancel);if(!Number.isFinite(ar)||ar<0||ar>1e8)return res.status(400).json({error:'El arancel tiene que ser un número de 0 o más'});nuevoAr=Math.round(ar);if(nuevoAr!==act0.arancel)c.arancel=nuevoAr}
 if(b.dias!==undefined)c.dias=up(txtc(b.dias));
 if(b.horarios!==undefined)c.horarios=txtc(b.horarios);
 if(b.tallerista_nombre!==undefined){if(!b.tallerista_nombre||!b.tallerista_contacto)return res.status(400).json({error:'Completá nombre completo y contacto del tallerista'});
  Object.assign(c,{tallerista_nombre:up(txtc(b.tallerista_nombre)),tallerista_contacto:txtc(b.tallerista_contacto),tallerista_dni:txtc(b.tallerista_dni,30)||null,tallerista_cvu:txtc(b.tallerista_cvu,100)||null})}
 if(b.estado!==undefined){await q('UPDATE actividades SET estado=? WHERE id=?',[b.estado,id]);await audit(req.u.nombre,'estado','actividad',id,b.estado)}
 const ks=Object.keys(c);if(ks.length){await q(`UPDATE actividades SET ${ks.map(k=>k+'=?').join(',')} WHERE id=?`,[...ks.map(k=>c[k]),id]);await audit(req.u.nombre,'modificar','actividad',id,ks.map(k=>k.replace('_',' ')).join(', '))}
 /* Cambio de arancel: las inscripciones PENDIENTES toman el monto nuevo (con su cupón); las que ya pagaron (estado distinto de pendiente) conservan el monto que pagaron y no quedan como deuda. */
 let res_={ok:1};
 if(c.arancel!==undefined){const pend=await q("SELECT i.id,c.tipo,c.valor FROM inscripciones i LEFT JOIN cupones c ON c.id=i.cupon_id WHERE i.actividad_id=? AND i.estado='pendiente'",[id]),[pg]=await q("SELECT COUNT(*) n FROM inscripciones WHERE actividad_id=? AND estado!='pendiente'",[id]);
  for(let k=0;k<pend.length;k+=200)await db.batch(pend.slice(k,k+200).map(p=>({sql:'UPDATE inscripciones SET monto=? WHERE id=? AND estado=\'pendiente\'',args:[montoCon(c.arancel,p.tipo?p:null),p.id]})),'write');
  res_={ok:1,pendientes:pend.length,pagas:pg.n};await audit(req.u.nombre,'cambiar arancel','actividad',id,`${act0.arancel} → ${c.arancel} (${pend.length} pendientes actualizadas, ${pg.n} pagas sin cambios)`)}
 res.json(res_)}));
app.delete('/api/actividades/:id',adm,wrap(async(req,res)=>{await q('DELETE FROM actividades WHERE id=?',[req.params.id]);await audit(req.u.nombre,'eliminar','actividad',+req.params.id);res.json({ok:1})}));

/* Cupones y eventos */
app.get('/api/cupones',adm,wrap(async(req,res)=>res.json(await q('SELECT * FROM cupones'))));
app.get('/api/cupones/activos',ap,wrap(async(req,res)=>res.json(await q('SELECT codigo,tipo,valor FROM cupones WHERE activo=1 ORDER BY codigo'))));
app.post('/api/cupones',adm,wrap(async(req,res)=>{const c=req.body;await q('INSERT INTO cupones(codigo,tipo,valor) VALUES(?,?,?)',[c.codigo.trim(),c.tipo,+c.valor]);await audit(req.u.nombre,'crear','cupon',0,c.codigo);res.json({ok:1})}));
app.get('/api/eventos',adm,wrap(async(req,res)=>res.json(await q('SELECT e.*,b.id AS bordereaux_id,b.numero AS bordereaux_numero,b.anio AS bordereaux_anio FROM eventos_puntuales e LEFT JOIN bordereaux b ON b.evento_id=e.id ORDER BY e.fecha DESC'))));
app.delete('/api/eventos/:id',adm,wrap(async(req,res)=>{const id=+req.params.id,[e]=await q('SELECT nombre FROM eventos_puntuales WHERE id=?',[id]);if(!e)return res.sendStatus(404);
 if((await q('SELECT 1 FROM bordereaux WHERE evento_id=?',[id])).length)return res.status(409).json({error:'El evento tiene un bordereaux. Eliminá primero el bordereaux (desde Bordereaux).'});
 await q('DELETE FROM eventos_puntuales WHERE id=?',[id]);await audit(req.u.nombre,'eliminar','evento',id,e.nombre);res.json({ok:1})}));
const FRANJAS=['Menos de 6','6 a 11','12 a 17','18 a 24','25 a 35','36 a 55','Más de 55'];
function parseEv(b){const bad=m=>{throw{status:400,error:m}};
 const nombre=up(txtc(b.nombre));if(!nombre)bad('Falta el nombre del evento');
 const fecha=txtc(b.fecha,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(fecha)||isNaN(new Date(fecha)))bad('La fecha del evento es inválida');
 const num=(v,n)=>{const x=v===''||v==null?0:Number(v);if(!Number.isFinite(x)||x<0||x>1e10)bad(`${n}: tiene que ser un número de 0 o más`);return x};
 return{nombre,fecha,horario:txtc(b.horario,60),asistentes:Math.round(num(b.asistentes,'Cantidad de asistentes')),artista:txtc(b.artista,300),descripcion:txtc(b.descripcion,500),monto:Math.round(num(b.monto,'Monto recaudado')*100)/100,franjas:[].concat(b.franjas||[]).filter(x=>FRANJAS.includes(x)).join(',')}}
app.post('/api/eventos',adm,wrap(async(req,res)=>{const e=parseEv(req.body);
 const r=await db.execute({sql:'INSERT INTO eventos_puntuales(nombre,fecha,horario,asistentes,artista,descripcion,monto,creado_por,franjas) VALUES(?,?,?,?,?,?,?,?,?)',args:[e.nombre,e.fecha,e.horario,e.asistentes,e.artista,e.descripcion,e.monto,req.u.id,e.franjas]});
 await audit(req.u.nombre,'crear','evento',Number(r.lastInsertRowid),e.nombre);res.json({ok:1})}));
/* Editar un evento. Si viene de un bordereaux, sus datos (público, monto, fecha…) salen de la rendición: se edita desde Bordereaux para que no queden dos versiones. */
app.put('/api/eventos/:id',adm,wrap(async(req,res)=>{const id=+req.params.id;
 if(!(await q('SELECT 1 FROM eventos_puntuales WHERE id=?',[id])).length)return res.sendStatus(404);
 if((await q('SELECT 1 FROM bordereaux WHERE evento_id=?',[id])).length)return res.status(409).json({error:'Este evento tiene un bordereaux: editalo desde Bordereaux para que los datos coincidan.'});
 const e=parseEv(req.body);
 await q('UPDATE eventos_puntuales SET nombre=?,fecha=?,horario=?,asistentes=?,artista=?,descripcion=?,monto=?,franjas=? WHERE id=?',[e.nombre,e.fecha,e.horario,e.asistentes,e.artista,e.descripcion,e.monto,e.franjas,id]);
 await audit(req.u.nombre,'modificar','evento',id,e.nombre);res.json({ok:1})}));

/* Inscripciones: el monto SIEMPRE lo calcula el servidor; siempre nacen 'pendiente' */
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* DNI sin puntos, espacios ni guiones, para comparar aunque esté cargado con otro formato */
const DNIN="REPLACE(REPLACE(REPLACE(dni,'.',''),' ',''),'-','')";
try{await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_ins_dni_act ON inscripciones(actividad_id,dni)')}catch(e){console.warn('Índice único DNI+actividad no creado (hay inscripciones duplicadas por limpiar):',e.message)}
async function crear(d,origen,quien){
 const ids=[...new Set([].concat(d.actividades||[]).map(Number))];
 if(!ids.length||!d.nombre||!d.dni||!d.fecha_nac||!d.mail||!d.whatsapp||!d.metodo_pago)throw{status:400,error:'Faltan datos obligatorios'};
 d.dni=String(d.dni).replace(/\D/g,'');if(d.dni.length<6)throw{status:400,error:'DNI inválido'};
 if(!['Mercado Pago','Transferencia','Efectivo'].includes(d.metodo_pago))throw{status:400,error:'Método de pago inválido'};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha_nac))||isNaN(new Date(d.fecha_nac))||edad(d.fecha_nac)<0||edad(d.fecha_nac)>120)throw{status:400,error:'Fecha de nacimiento inválida'};
 const MAY=['nombre','tutor_nombre','direccion','barrio','localidad','provincia']; // estos datos se guardan siempre en MAYÚSCULAS
 for(const k of [...MAY,'mail','whatsapp'])if(d[k]!=null)d[k]=MAY.includes(k)?up(String(d[k]).trim().slice(0,200)):String(d[k]).trim().slice(0,200);
 if(!d.nombre||!d.mail||!d.whatsapp)throw{status:400,error:'Faltan datos obligatorios'};
 const menor=edad(d.fecha_nac)<18?1:0;
 if(menor&&!d.tutor_nombre)throw{status:400,error:'Falta el nombre del tutor'};
 let c=null;if(d.cupon){[c]=await q('SELECT * FROM cupones WHERE codigo=? COLLATE NOCASE AND activo=1',[d.cupon.trim()]);if(!c)throw{status:400,error:'El cupón no es válido'}}
 const creadas=[],acts=[];
 /* Primero se valida todo (actividades y DNI repetido) para no dejar la inscripción a medias */
 for(const id of ids){
  const [a]=await q("SELECT * FROM actividades WHERE id=? AND estado='activa'",[id]);if(!a)throw{status:400,error:'Actividad no disponible'};
  if((await q(`SELECT 1 FROM inscripciones WHERE ${DNIN}=? AND actividad_id=?`,[d.dni,id])).length)throw{status:409,error:`Ya existe una inscripción con ese DNI en "${a.nombre}"`};acts.push(a)}
 for(const a of acts){const id=a.id;
  const m=montoCon(a.arancel,c);
  /* Alta atómica: si en el mismo instante entra otra con el mismo DNI y actividad (doble clic, dos envíos), solo una se guarda */
  let r;try{r=await db.execute({sql:`INSERT INTO inscripciones(actividad_id,nombre,dni,fecha_nac,es_menor,tutor_nombre,mail,whatsapp,direccion,barrio,localidad,provincia,metodo_pago,cupon_id,monto,origen,creado_por) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM inscripciones WHERE ${DNIN}=? AND actividad_id=?)`,
   args:[id,d.nombre,d.dni,d.fecha_nac,menor,menor?d.tutor_nombre:null,d.mail,d.whatsapp,d.direccion||null,d.barrio||null,d.localidad||null,d.provincia||null,d.metodo_pago,c?.id||null,m,origen,quien.id||null,d.dni,id]})}catch(e){if(/UNIQUE/i.test(String(e?.message)))throw{status:409,error:`Ya existe una inscripción con ese DNI en "${a.nombre}"`};throw e}
  if(!r.rowsAffected)throw{status:409,error:`Ya existe una inscripción con ese DNI en "${a.nombre}"`};
  await audit(quien.nombre,'inscribir','inscripcion',Number(r.lastInsertRowid),`${d.nombre} en ${a.nombre} (${m}${c?', cupón '+c.codigo:''})`);creadas.push({actividad:a.nombre,monto:m});
 }
 const wa=(E.WHATSAPP_CONTACTO||'').replace(/\D/g,'');
 mail(d.mail,'¡Recibimos tu inscripción!',`<div style="font-family:Arial,sans-serif;max-width:520px"><h2>¡Recibimos tu inscripción!</h2><p>Hola ${esc(d.nombre)},</p><p>Tu lugar ya está reservado a la espera de la confirmación.${wa?` Para completarla, enviá tu comprobante por WhatsApp al <a href="https://wa.me/${wa}">${wa}</a>.`:''}</p><p><b>Detalle de tu registro</b></p><ul>${creadas.map(x=>`<li>${esc(x.actividad)} — $${x.monto}</li>`).join('')}</ul><p>Método de pago: ${esc(d.metodo_pago)}</p><p>Saludos 🙌</p></div>`);
 return creadas}
app.post('/api/inscripciones',ap,(req,res)=>crear(req.body,'ap',req.u).then(r=>res.json(r)).catch(e=>fail(res,e)));
app.get('/api/inscripciones',ap,wrap(async(req,res)=>{const {actividad,estado,origen}=req.query;
 /* actividad_estado y periodo: para marcar las suspendidas; cargado_por: usuario que la cargó (las de la web no tienen usuario) */
 res.json(await q(`SELECT i.*,(SELECT COUNT(*) FROM inscripciones y WHERE y.actividad_id=i.actividad_id AND REPLACE(REPLACE(REPLACE(y.dni,'.',''),' ',''),'-','')=REPLACE(REPLACE(REPLACE(i.dni,'.',''),' ',''),'-','')) AS veces,a.nombre AS actividad,a.periodo,a.estado AS actividad_estado,c.codigo AS cupon,u.nombre AS cargado_por FROM inscripciones i LEFT JOIN actividades a ON a.id=i.actividad_id LEFT JOIN cupones c ON c.id=i.cupon_id LEFT JOIN usuarios u ON u.id=i.creado_por WHERE (?1 IS NULL OR i.actividad_id=?1) AND (?2 IS NULL OR i.estado=?2) AND (?3 IS NULL OR i.origen=?3) ORDER BY i.id DESC`,[actividad||null,estado||null,origen||null]))}));
const SUSP='La actividad está suspendida: no se puede editar, cambiar el estado ni eliminar sus inscripciones. Reactivala desde Actividades si necesitás modificarlas.';
/* Editar: no se puede si la actividad está suspendida, ni pasar la inscripción a una actividad suspendida */
app.patch('/api/inscripciones/:id',ap,wrap(async(req,res)=>{const [i]=await q('SELECT i.*,a.estado AS act_estado FROM inscripciones i LEFT JOIN actividades a ON a.id=i.actividad_id WHERE i.id=?',[req.params.id]);if(!i)return res.sendStatus(404);
 if(i.act_estado==='suspendida')return res.status(409).json({error:SUSP});
 const b=req.body;let act=i.actividad_id;
 if(b.actividad_id&&b.actividad_id!=i.actividad_id){const [o]=await q('SELECT * FROM actividades WHERE id=?',[i.actividad_id]),[n]=await q('SELECT * FROM actividades WHERE id=?',[b.actividad_id]);
  if(!o||!n||n.tipo!==o.tipo||n.arancel!==o.arancel)return res.status(400).json({error:'Solo se puede cambiar a una actividad de la misma categoría y monto. Eliminá y volvé a inscribir.'});
  if(n.estado!=='activa')return res.status(409).json({error:'Esa actividad está suspendida: no se pueden pasar inscripciones a ella.'});act=n.id}
 const nombre=b.nombre!=null?up(b.nombre).slice(0,200):i.nombre;if(!nombre)return res.status(400).json({error:'Falta el nombre'});
 let dni=i.dni;if(b.dni!=null){dni=String(b.dni).replace(/\D/g,'');if(dni.length<6)return res.status(400).json({error:'DNI inválido'})}
 if(dni!==String(i.dni).replace(/\D/g,'')||act!==i.actividad_id){const [d2]=await q("SELECT a.nombre FROM inscripciones x JOIN actividades a ON a.id=x.actividad_id WHERE REPLACE(REPLACE(REPLACE(x.dni,'.',''),' ',''),'-','')=? AND x.actividad_id=? AND x.id!=?",[dni.replace(/\D/g,''),act,i.id]);if(d2)return res.status(409).json({error:`Ya existe una inscripción con ese DNI en "${d2.nombre}"`})}
 await q('UPDATE inscripciones SET nombre=?,dni=?,mail=?,whatsapp=?,actividad_id=? WHERE id=?',[nombre,dni,String(b.mail??i.mail).trim().slice(0,200),String(b.whatsapp??i.whatsapp).trim().slice(0,200),act,i.id]);
 await audit(req.u.nombre,'modificar','inscripcion',i.id,nombre);res.json({ok:1})}));
app.patch('/api/inscripciones/:id/estado',ap,wrap(async(req,res)=>{const e=req.body.estado;if(!['pendiente','inscripto'].includes(e))return res.sendStatus(400);
 const [i]=await q('SELECT i.*,a.nombre AS actividad,a.estado AS act_estado FROM inscripciones i JOIN actividades a ON a.id=i.actividad_id WHERE i.id=?',[req.params.id]);
 if(!i)return res.sendStatus(404);
 if(i.act_estado==='suspendida')return res.status(409).json({error:SUSP});
 if(i.estado!=='pendiente'&&req.u.rol==='ap')return res.status(403).json({error:'Solo un administrador puede modificar el estado de una inscripción ya confirmada'});
 await q('UPDATE inscripciones SET estado=? WHERE id=?',[e,i.id]);await audit(req.u.nombre,'estado','inscripcion',i.id,`${i.estado} → ${e}`);
 if(e!=='pendiente'&&i.estado==='pendiente'&&req.body.enviar_mail)await mail(i.mail,'Inscripción confirmada',`<p>Hola ${esc(i.nombre)}, tu inscripción a <b>${esc(i.actividad)}</b> está confirmada.</p>`);res.json({ok:1})}));
/* Eliminar: la inscripción se borra, pero queda guardado el contacto (nombre completo, mail, contacto y localidad).
   Si era menor de edad se guardan SOLO los datos del tutor, y el nombre del menor se saca también del historial. Todo en una sola operación. */
app.delete('/api/inscripciones/:id',ap,wrap(async(req,res)=>{const id=+req.params.id;
 const [i]=await q('SELECT i.*,a.nombre AS actividad,a.estado AS act_estado FROM inscripciones i LEFT JOIN actividades a ON a.id=i.actividad_id WHERE i.id=?',[id]);if(!i)return res.sendStatus(404);
 if(i.act_estado==='suspendida')return res.status(409).json({error:SUSP});
 const menor=!!i.es_menor,nombre=menor?i.tutor_nombre:i.nombre,st=[];
 const clave=String(i.mail||'').trim().toLowerCase()+'|'+String(i.whatsapp||'').replace(/\D/g,'');
 if(clave!=='|')st.push({sql:'INSERT INTO contactos_eliminados(clave,nombre,mail,whatsapp,localidad,es_tutor,eliminado_por) VALUES(?,?,?,?,?,?,?) ON CONFLICT(clave) DO UPDATE SET nombre=excluded.nombre,mail=excluded.mail,whatsapp=excluded.whatsapp,localidad=excluded.localidad,es_tutor=excluded.es_tutor,eliminado_por=excluded.eliminado_por,eliminado_en=CURRENT_TIMESTAMP',args:[clave,nombre||null,i.mail||null,i.whatsapp||null,i.localidad||null,menor?1:0,req.u.nombre]});
 if(menor&&String(i.nombre||'').trim()){const re=new RegExp(String(i.nombre).trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
  for(const a of await q("SELECT id,detalle FROM auditoria WHERE entidad='inscripcion' AND entidad_id=?",[id])){const nd=String(a.detalle||'').replace(re,'MENOR');if(nd!==a.detalle)st.push({sql:'UPDATE auditoria SET detalle=? WHERE id=?',args:[nd,a.id]})}}
 st.push({sql:'DELETE FROM inscripciones WHERE id=?',args:[id]});
 await db.batch(st,'write');
 await audit(req.u.nombre,'eliminar','inscripcion',id,`${menor?'MENOR (tutor: '+(i.tutor_nombre||'—')+')':i.nombre} en ${i.actividad||'—'} · contacto guardado`);res.json({ok:1})}));
/* Contactos de inscripciones eliminadas (solo administrador): lista, Excel y borrado definitivo */
app.get('/api/contactos-eliminados',adm,wrap(async(req,res)=>res.json(await q('SELECT id,nombre,mail,whatsapp,localidad,es_tutor,eliminado_por,eliminado_en FROM contactos_eliminados ORDER BY eliminado_en DESC,id DESC'))));
app.get('/api/contactos-eliminados.xlsx',adm,wrap(async(req,res)=>{
 const rows=(await q('SELECT nombre,mail,whatsapp,localidad,es_tutor,eliminado_por,eliminado_en FROM contactos_eliminados ORDER BY nombre')).map(r=>({nombre:r.nombre,tipo:r.es_tutor?'Tutor/a de menor':'Persona',mail:r.mail,whatsapp:r.whatsapp,localidad:r.localidad,fecha:fmtAR(r.eliminado_en),por:r.eliminado_por}));
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Contactos');
 ws.columns=[['nombre','Nombre completo',32],['tipo','Tipo',18],['mail','Mail',30],['whatsapp','WhatsApp',18],['localidad','Localidad',20],['fecha','Eliminado el',18],['por','Eliminado por',22]].map(([key,header,width])=>({key,header,width}));
 ws.addRows(rows);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename=contactos-eliminados.xlsx');await wb.xlsx.write(res);res.end()}));
app.delete('/api/contactos-eliminados/:id',adm,wrap(async(req,res)=>{const id=+req.params.id;
 const r=await db.execute({sql:'DELETE FROM contactos_eliminados WHERE id=?',args:[id]});if(!r.rowsAffected)return res.sendStatus(404);
 await audit(req.u.nombre,'eliminar definitivamente','contacto',id);res.json({ok:1})}));
/* Autocompletar por DNI (solo usuarios logueados) */
app.get('/api/personas/:dni',ap,wrap(async(req,res)=>{const d=String(req.params.dni).replace(/\D/g,'');
 const [p]=await q("SELECT nombre,dni,fecha_nac,tutor_nombre,mail,whatsapp,direccion,barrio,localidad,provincia FROM inscripciones WHERE REPLACE(REPLACE(dni,'.',''),' ','')=? ORDER BY id DESC LIMIT 1",[d]);res.json(p||null)}));
app.get('/api/auditoria',ap,wrap(async(req,res)=>res.json(await q('SELECT * FROM auditoria ORDER BY id DESC LIMIT 300'))));

/* ===== Bordereaux (rendición de eventos). Al guardar crea o actualiza el evento: nombre, fecha, artistas, asistentes y el % para el I.C.Ch. ===== */
/* Reglas de la liquidación (todas sobre el TOTAL RECAUDADO): I.C.Ch. fijo; SADAIC y ARGENTORES retienen o no. Para cambiar una regla, editar acá. */
const ICH_PCT=10,SADAIC_OPC=[0,10],ARGENTORES_OPC=[0,10,15,20,25];
/* Todo en centavos para evitar errores de redondeo. Productora = total recaudado - SADAIC - ARGENTORES - I.C.Ch. (retenciones + I.C.Ch. + productora = total). */
function calcBor(rows,pct){
 let tot=0,pub=0,inv=0;
 const out=rows.map(r=>{const rc=Math.round(r.precio*100)*r.vendidas;tot+=rc;pub+=r.vendidas;if(/^invitad/i.test(r.tipo))inv+=r.vendidas;return{...r,recaudacion:rc/100}});
 const sad=Math.round(tot*pct.sadaic/100),arg=Math.round(tot*pct.argentores/100),ich=Math.round(tot*pct.ich/100);
 return{rows:out,total_recaudado:tot/100,total_publico:pub,total_invitados:inv,ret_sadaic:sad/100,ret_argentores:arg/100,ret_total:(sad+arg)/100,para_ich:ich/100,para_productora:(tot-sad-arg-ich)/100}}
function parseBor(b){
 const bad=m=>{throw{status:400,error:m}};
 const txt=(v,max=200)=>String(v??'').trim().slice(0,max);
 const hora=(v,n)=>{v=txt(v,5);if(v&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))bad(`${n}: hora inválida`);return v};
 const fecha=(v,n,req)=>{v=txt(v,10);if(!v){if(req)bad(`Falta ${n}`);return''}if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(new Date(v)))bad(`${n}: fecha inválida`);return v};
 const ent=(v,n)=>{if(v===''||v==null)return null;const x=Number(v);if(!Number.isInteger(x)||x<0||x>1e7)bad(`${n}: tiene que ser un número entero`);return x};
 const nombre=up(txt(b.nombre));if(!nombre)bad('Falta el nombre del evento');
 const f=fecha(b.fecha,'la fecha del evento',true);
 const rows=[];
 [].concat(b.entradas||[]).slice(0,5).forEach((r,i)=>{r=r||{};
  const tipo=txt(r.tipo,40),n=tipo||`Fila ${i+1} de entradas`;
  const desde=ent(r.desde,`${n} (desde)`),hasta=ent(r.hasta,`${n} (hasta)`),vendidas=ent(r.vendidas,`${n} (vendidas)`)??0;
  const precio=r.precio===''||r.precio==null?0:Number(r.precio);
  if(!Number.isFinite(precio)||precio<0||precio>1e9)bad(`${n}: precio inválido`);
  if(!tipo&&desde==null&&hasta==null&&!vendidas&&!precio)return;
  if(!tipo)bad(`${n}: falta el tipo`);
  if(desde!=null&&hasta!=null){
   if(hasta<desde)bad(`${tipo}: "hasta" no puede ser menor que "desde"`);
   if(vendidas>hasta-desde+1)bad(`${tipo}: las vendidas (${vendidas}) superan el rango ${desde} a ${hasta} (${hasta-desde+1} entradas)`)}
  rows.push({tipo,desde,hasta,precio:Math.round(precio*100)/100,vendidas})});
 if(!rows.length)bad('Cargá al menos un tipo de entrada');
 const pc=(v,ok,n)=>{const x=v==null||v===''?10:Number(String(v).replace(',','.'));if(!Number.isFinite(x)||x<0||x>100||Math.abs(x*100-Math.round(x*100))>1e-9)bad(`${n}: poné un porcentaje entre 0 y 100 (hasta 2 decimales; 0 = no retiene)`);return x};
 const pct={sadaic:pc(b.sadaic_pct,SADAIC_OPC,'SADAIC'),argentores:pc(b.argentores_pct,ARGENTORES_OPC,'ARGENTORES'),ich:ICH_PCT};
 if(pct.sadaic+pct.argentores+pct.ich>100)bad('Las retenciones (SADAIC + ARGENTORES + I.C.Ch.) no pueden superar el 100 %');
 const numero=ent(b.numero,'Bordereaux Nº');if(numero===0)bad('El Nº de bordereaux tiene que ser 1 o más');
 return{nombre,fecha:f,artista:txt(b.artista,300),hora_inicio:hora(b.hora_inicio,'Hora de inicio'),hora_cierre:hora(b.hora_cierre,'Hora de cierre'),
  actividad:txt(b.actividad,100),produccion:txt(b.produccion,150),cuit:txt(b.cuit,20),telefono:txt(b.telefono,40),domicilio:txt(b.domicilio,200),
  resolucion:txt(b.resolucion,40),interviene:txt(b.interviene,100),fecha_pago_ret:fecha(b.fecha_pago_ret,'la fecha de pago de retenciones',false),
  liq_fecha:fecha(b.liq_fecha,'la fecha de liquidación',false),liq_hora:hora(b.liq_hora,'Hora de liquidación'),
  firma_icch:b.firma_icch&&b.firma_icch!=='0'?1:0,rows,pct,franjas:[].concat(b.franjas||[]).filter(x=>FRANJAS.includes(x)),numero,evento_id:b.evento_id?Number(b.evento_id):null}}
const BCOLS=['anio','numero','resolucion','hora_inicio','hora_cierre','actividad','produccion','cuit','telefono','domicilio','entradas','sadaic_pct','argentores_pct','ich_pct','fecha_pago_ret','liq_fecha','liq_hora','interviene','total_recaudado','total_publico','total_invitados','ret_sadaic','ret_argentores','ret_total','para_ich','para_productora','firma_icch'];
async function saveBor(req,res,id){try{
 const d=parseBor(req.body),k=calcBor(d.rows,d.pct),anio=+d.fecha.slice(0,4);
 let old=null;if(id){[old]=await q('SELECT * FROM bordereaux WHERE id=?',[id]);if(!old)return res.sendStatus(404);if(old.firma_fecha)throw{status:409,error:'Este bordereaux ya está firmado por la productora. Para modificarlo, primero anulá la firma.'}}
 const numero=d.numero||(((await q('SELECT MAX(numero) m FROM bordereaux WHERE anio=?',[anio]))[0].m||0)+1);
 if((await q('SELECT 1 FROM bordereaux WHERE anio=? AND numero=? AND id!=?',[anio,numero,id||0])).length)throw{status:409,error:`Ya existe el bordereaux Nº ${numero} de ${anio}`};
 let eid=old?old.evento_id:d.evento_id;
 if(!old&&eid){
  if(!(await q('SELECT 1 FROM eventos_puntuales WHERE id=?',[eid])).length)throw{status:400,error:'El evento elegido no existe'};
  if((await q('SELECT 1 FROM bordereaux WHERE evento_id=?',[eid])).length)throw{status:409,error:'Ese evento ya tiene un bordereaux'}}
 const horario=[d.hora_inicio,d.hora_cierre].filter(Boolean).join(' a '),fr=d.franjas.join(',');
 const V=[anio,numero,d.resolucion,d.hora_inicio,d.hora_cierre,d.actividad,d.produccion,d.cuit,d.telefono,d.domicilio,JSON.stringify(k.rows),d.pct.sadaic,d.pct.argentores,d.pct.ich,d.fecha_pago_ret,d.liq_fecha,d.liq_hora,d.interviene,k.total_recaudado,k.total_publico,k.total_invitados,k.ret_sadaic,k.ret_argentores,k.ret_total,k.para_ich,k.para_productora,d.firma_icch];
 const evUpd=id=>({sql:'UPDATE eventos_puntuales SET nombre=?,fecha=?,horario=?,asistentes=?,artista=?,monto=?,franjas=? WHERE id=?',args:[d.nombre,d.fecha,horario,k.total_publico,d.artista,k.para_ich,fr,id]});
 const ins=(ev,pre)=>({sql:`INSERT INTO bordereaux(evento_id,creado_por,${BCOLS}) VALUES(${ev},?,${BCOLS.map(()=>'?')})`,args:[...pre,req.u.nombre,...V]});
 let stmts;
 if(old)stmts=[evUpd(eid),{sql:`UPDATE bordereaux SET ${BCOLS.map(c=>c+'=?')} WHERE id=?`,args:[...V,id]}];
 else if(eid)stmts=[evUpd(eid),ins('?',[eid])];
 else stmts=[{sql:'INSERT INTO eventos_puntuales(nombre,fecha,horario,asistentes,artista,descripcion,monto,creado_por,franjas) VALUES(?,?,?,?,?,?,?,?,?)',args:[d.nombre,d.fecha,horario,k.total_publico,d.artista,'',k.para_ich,req.u.id,fr]},ins('(SELECT last_insert_rowid())',[])];
 const r=await db.batch(stmts,'write');
 const bid=id||Number(r[1].lastInsertRowid);if(!eid)eid=Number(r[0].lastInsertRowid);
 await audit(req.u.nombre,id?'modificar':'crear','bordereaux',bid,`Nº ${numero}/${anio} · ${d.nombre}`);
 await audit(req.u.nombre,(id||d.evento_id)?'actualizar':'crear','evento',eid,`${d.nombre} (desde bordereaux)`);
 res.json({id:bid,evento_id:eid,numero,anio,...k})}
 catch(e){if(/UNIQUE/i.test(String(e?.message)))return res.status(409).json({error:'Ya existe un bordereaux con ese número o para ese evento'});fail(res,e)}}
/* ===== Convenio de uso/alquiler (Word) a partir de un bordereaux. Datos precargados, editables; no se guarda nada. ===== */
const MESES=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const LEMA_CONV='“2026 - Año del 100° Aniversario de la sanción de la Ley de Derechos Civiles de la Mujer - Ley nacional 11.357-”. Ley N° 4202-A';
const dmy=iso=>/^\d{4}-\d{2}-\d{2}$/.test(iso||'')?{d:+iso.slice(8),m:MESES[+iso.slice(5,7)-1],a:iso.slice(0,4),dmy:`${iso.slice(8)}/${iso.slice(5,7)}/${iso.slice(0,4)}`}:null;
/* Día hábil = lunes a viernes que no sea feriado nacional (lista 2026-2027; si falta alguno, el administrador puede corregir la fecha a mano). */
const FERIADOS=new Set(['2026-01-01','2026-02-16','2026-02-17','2026-03-23','2026-03-24','2026-04-02','2026-04-03','2026-05-01','2026-05-25','2026-06-15','2026-06-20','2026-07-09','2026-07-10','2026-08-17','2026-10-12','2026-11-23','2026-12-07','2026-12-08','2026-12-25',
 '2027-01-01','2027-02-08','2027-02-09','2027-03-24','2027-03-26','2027-04-02','2027-05-01','2027-05-25','2027-06-17','2027-06-20','2027-07-09','2027-08-16','2027-10-11','2027-11-20','2027-12-08','2027-12-25']);
const esHabil=i=>{const w=new Date(i+'T12:00:00Z').getUTCDay();return w>0&&w<6&&!FERIADOS.has(i)};
const habilAntes=i=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(i||''))return '';const d=new Date(i+'T12:00:00Z');do d.setUTCDate(d.getUTCDate()-1);while(!esHabil(d.toISOString().slice(0,10)));return d.toISOString().slice(0,10)};
app.get('/api/convenio-habil',adm,(req,res)=>res.json({fecha:habilAntes(String(req.query.f||''))}));
const pesos=v=>{const n=Number(String(v??'').replace(/\./g,'').replace(',','.'));return String(v??'').trim()!==''&&Number.isFinite(n)&&/^[\d.,\s]+$/.test(String(v))?'$ '+n.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})+'.-':String(v??'').trim()};
app.get('/api/convenio/:id/datos',adm,wrap(async(req,res)=>{
 const [b]=await q('SELECT b.*,e.nombre,e.fecha FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[req.params.id]);if(!b)return res.sendStatus(404);
 const ent=JSON.parse(b.entradas||'[]'),cu=String(b.cuit||'').replace(/\D/g,''),dni8=cu.length==11?cu.slice(2,10):'',act=String(b.actividad||'').trim(),art=/a$/i.test(act.split(/\s+/)[0]||'')?'la':'el';
 res.json({fecha_firma:habilAntes(b.fecha)||hoyAR(),prod:b.produccion||'',prod_dom:b.domicilio||'',prod_cuit:b.cuit||'',firma_nombre:b.produccion||'',firma_dni:dni8?dni8.replace(/(\d{2})(\d{3})(\d{3})/,'$1.$2.$3'):'',
  tipo_evento:act?`${art} ${act}`:'',evento:b.nombre,fecha_evento:b.fecha,hora_desde:b.hora_inicio||'',hora_hasta:b.hora_cierre||'',
  filas:ent.filter(r=>!/^invitad/i.test(r.tipo||'')).map(r=>({car:r.tipo,cant:r.desde!=null&&r.hasta!=null?r.hasta-r.desde+1:(r.vendidas||''),costo:r.precio||0})),
  inst:1,monto_fijo:'$...........',forma_pago:'EFECTIVO',merch:'Pesos…………..($.........)',multa:'pesos ……..($........)',lema:LEMA_CONV})}));
/* Arma los campos y filas del convenio a partir de lo que cargó el administrador */
function convBuild(x){x=x||{};const t=(k,n=200)=>String(x[k]??'').replace(/[\r\n\t]+/g,' ').trim().slice(0,n),bad=m=>{throw{status:400,error:m}};
 const ff=dmy(t('fecha_firma',10)),fe=dmy(t('fecha_evento',10));if(!ff)bad('Falta la fecha de firma del convenio');if(!fe)bad('Falta la fecha del evento');
 const fi=t('fecha_firma',10),ei=t('fecha_evento',10);if(fi>=ei)bad(`La fecha de firma del convenio debe ser anterior a la del evento (sugerida: ${dmy(habilAntes(ei)).dmy})`);if(!esHabil(fi))bad(`La fecha de firma ${ff.dmy} no es un día hábil (sugerida: ${dmy(habilAntes(ei)).dmy})`);
 const filas=[].concat(x.filas||[]).slice(0,10).map(r=>({fecha:fe.dmy,car:String(r?.car??'').trim().slice(0,40),cant:String(r?.cant??'').trim().slice(0,10),costo:pesos(r?.costo)})).filter(r=>r.car||r.cant||r.costo);
 if(!filas.length)bad('Cargá al menos una fila en el anexo de entradas');
 const obra=`${t('tipo_evento',60)} ${up(t('evento',150))}`.trim(),hd=t('hora_desde',5),hh=t('hora_hasta',5);
 const f={f_dia:ff.d,f_mes:ff.m,f_anio:ff.a,prod:t('prod'),prod_dom:t('prod_dom'),prod_cuit:t('prod_cuit',30),obra,ev_fecha:`${fe.d} de ${fe.m}`,horario:hd&&hh?`${hd} a ${hh} HS`:(t('horario')||''),
  monto_fijo:t('monto_fijo',100)+' ',forma_pago:t('forma_pago',100),merch:t('merch'),multa:t('multa'),firma_nombre:t('firma_nombre'),firma_dni:t('firma_dni',30),lema:t('lema',250),inst:x.inst===false||x.inst==='0'||x.inst===0?0:1};
 filas.forEach(r=>r.evento=obra.replace(/^(el|la|los|las)\s+/i,''));return{f,filas}}
const docxRes=(res,buf,nombre)=>{res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');res.setHeader('Content-Disposition',`attachment; filename="convenio.docx"; filename*=UTF-8''${encodeURIComponent('CONVENIO - '+String(nombre).slice(0,60)+'.docx')}`);res.end(buf)};
const convBor=async id=>{const [b]=await q('SELECT b.id,b.numero,b.anio,e.nombre FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[id]);return b};
app.post('/api/convenio/:id/docx',adm,wrap(async(req,res)=>{const b=await convBor(req.params.id);if(!b)return res.sendStatus(404);
 const {f,filas}=convBuild(req.body);await audit(req.u.nombre,'generar convenio','bordereaux',b.id,`Nº ${b.numero}/${b.anio} · ${b.nombre}`);docxRes(res,convenioDocx(f,filas,null,!!f.inst),b.nombre)}));
/* --- Envío a la productora para que firme (link con clave larga, firma electrónica como el bordereaux) --- */
await db.execute(`CREATE TABLE IF NOT EXISTS convenios_firma(id INTEGER PRIMARY KEY,bordereaux_id INTEGER UNIQUE,token TEXT UNIQUE,datos TEXT,creado_por TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP,enviado_a TEXT,firma_nombre TEXT,firma_dni TEXT,firma_img TEXT,firma_fecha TEXT,firma_ip TEXT,firma_hash TEXT)`);
for(const c of ['inst_token','inst_nombre','inst_dni','inst_img','inst_fecha','inst_ip','inst_hash'])try{await db.execute(`ALTER TABLE convenios_firma ADD COLUMN ${c} TEXT`)}catch{}
/* Todos los links que se comparten pasan primero por inicio.html (pantalla con el logo mientras el sistema arranca). Por defecto es la del propio sistema; si existe INICIO_URL se usa esa. */
const INICIO=String(E.INICIO_URL||'').trim();
const inicioUrl=req=>INICIO||origen(req)+'/inicio.html';
const enlace=(req,p)=>`${inicioUrl(req)}${inicioUrl(req).includes('?')?'&':'?'}ir=${encodeURIComponent(p)}`;
app.get('/api/inicio',ap,(req,res)=>res.json({url:inicioUrl(req)}));
const cvLink=(req,t)=>enlace(req,`/convenio.html?firma=${t}`);const tkn=()=>crypto.randomBytes(24).toString('hex');
const cvHash=d=>crypto.createHash('sha256').update(JSON.stringify([d.f,d.filas])).digest('hex');
const dniFmt=d=>String(d).replace(/\D/g,'').replace(/\B(?=(\d{3})+(?!\d))/g,'.');
function cvMail(to,d,link,inst){mail(to,`Convenio de uso de instalaciones: ${d.f.obra}`,`<div style="font-family:Arial,sans-serif;max-width:520px"><p>Hola${inst?' Francisco':(d.f.prod?' '+esc(d.f.prod):'')},</p><p>El Centro Cultural Alternativo te envía el <b>convenio de uso/alquiler de instalaciones</b> para ${esc(d.f.obra)} (${esc(d.f.ev_fecha)}) para que lo revises y lo firmes${inst?' en representación del Instituto':''}.</p><p><a href="${link}" style="background:#0f6b63;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Revisar y firmar</a></p><p>Se abre desde el celular o la computadora: firmás con el dedo o el mouse y completás tu nombre y DNI.</p><p>Saludos 🙌</p></div>`)}
app.get('/api/convenio/:id/estado',adm,wrap(async(req,res)=>{const [c]=await q('SELECT * FROM convenios_firma WHERE bordereaux_id=?',[+req.params.id]);
 if(!c)return res.json({existe:false});const d=JSON.parse(c.datos);res.json({existe:true,firmado:!!c.firma_fecha,firma_nombre:c.firma_nombre,firma_dni:c.firma_dni,firma_fecha:c.firma_fecha,enviado_a:c.enviado_a,link:c.firma_fecha?null:cvLink(req,c.token),inst:d.f.inst!==0,inst_firmado:!!c.inst_fecha,inst_nombre:c.inst_nombre,inst_dni:c.inst_dni,inst_fecha:c.inst_fecha,link_inst:d.f.inst===0&&!c.inst_fecha&&c.inst_token?cvLink(req,c.inst_token):null})}));
app.post('/api/convenio/:id/firma-link',adm,wrap(async(req,res)=>{const id=+req.params.id,b=await convBor(id);if(!b)return res.sendStatus(404);
 const to=String(req.body?.mail||'').trim();if(to&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))return res.status(400).json({error:'El mail no es válido'});
 const d=convBuild(req.body),[c]=await q('SELECT id,token,inst_token,firma_fecha,inst_fecha FROM convenios_firma WHERE bordereaux_id=?',[id]),para=req.body.para=='inst'?'inst':'prod';
 if(c?.firma_fecha||c?.inst_fecha)return res.status(409).json({error:'El convenio ya tiene una firma. Anulá las firmas si hay que corregirlo.'});
 let t=c?.token,ti=c?.inst_token;if(!t)t=tkn();if(!ti&&d.f.inst===0)ti=tkn();if(c&&req.body.nuevo){t=tkn();if(ti)ti=tkn()}
 if(!c)await q('INSERT INTO convenios_firma(bordereaux_id,token,inst_token,datos,creado_por) VALUES(?,?,?,?,?)',[id,t,ti||null,JSON.stringify(d),req.u.nombre]);
 else await q('UPDATE convenios_firma SET token=?,inst_token=?,datos=?,creado_por=? WHERE id=?',[t,ti||null,JSON.stringify(d),req.u.nombre,c.id]);
 const link=cvLink(req,t),link_inst=ti?cvLink(req,ti):null;if(to){cvMail(to,d,para=='inst'&&link_inst?link_inst:link,para=='inst');if(para!='inst')await q('UPDATE convenios_firma SET enviado_a=? WHERE bordereaux_id=?',[to,id])}
 await audit(req.u.nombre,to?'enviar a firmar':'generar link de firma','convenio',id,`Nº ${b.numero}/${b.anio} · ${b.nombre}${to?' → '+to:''}`);res.json({link,link_inst,mail:!!to})}));
app.delete('/api/convenio/:id/firma',adm,wrap(async(req,res)=>{const id=+req.params.id,r=await db.execute({sql:'DELETE FROM convenios_firma WHERE bordereaux_id=?',args:[id]});if(!r.rowsAffected)return res.sendStatus(404);await audit(req.u.nombre,'anular convenio/firma','convenio',id);res.json({ok:1})}));
app.get('/api/convenio/:id/firmado.docx',adm,wrap(async(req,res)=>{const b=await convBor(req.params.id),[c]=await q('SELECT * FROM convenios_firma WHERE bordereaux_id=?',[+req.params.id]);if(!b||!(c?.firma_fecha||c?.inst_fecha))return res.sendStatus(404);docxRes(res,cvDocx(c),b.nombre)}));
const cvDocx=c=>{const d=JSON.parse(c.datos);if(c.firma_fecha){d.f.firma_nombre=c.firma_nombre;d.f.firma_dni=dniFmt(c.firma_dni)}return convenioDocx(d.f,d.filas,c.firma_fecha?c.firma_img:null,c.inst_fecha?c.inst_img:d.f.inst!==0)};
/* Lo que ve y firma la productora */
const cvTok=async t=>{if(!/^[a-f0-9]{48}$/.test(String(t)))return null;let [c]=await q('SELECT * FROM convenios_firma WHERE token=?',[t]);if(c){c.rol='prod';return c}[c]=await q('SELECT * FROM convenios_firma WHERE inst_token=?',[t]);if(c)c.rol='inst';return c||null};
const cvOut=c=>{const d=JSON.parse(c.datos),f={...d.f};if(c.firma_fecha){f.firma_nombre=c.firma_nombre;f.firma_dni=dniFmt(c.firma_dni)}
 const mio=c.rol=='inst'?{firmado:!!c.inst_fecha,firma_nombre:c.inst_nombre,firma_dni:c.inst_dni,firma_fecha:c.inst_fecha,hash:c.inst_hash}:{firmado:!!c.firma_fecha,firma_nombre:c.firma_nombre,firma_dni:c.firma_dni,firma_fecha:c.firma_fecha,hash:c.firma_hash};
 return{texto:convenioTexto(f),filas:d.filas,lema:f.lema,rol:c.rol,inst_img:c.inst_fecha?c.inst_img:(f.inst===0?null:FIRMA_INST),inst_firmado:!!c.inst_fecha,inst_pendiente:f.inst===0&&!c.inst_fecha,firmante:{nombre:f.firma_nombre,dni:f.firma_dni},prod_firmado:!!c.firma_fecha,firma_img:c.firma_fecha?c.firma_img:null,firmado:mio.firmado,firma_nombre:mio.firma_nombre,firma_dni:mio.firma_dni,firma_fecha:mio.firma_fecha,verificacion:mio.hash?mio.hash.slice(0,12).toUpperCase():null}};
const cvNo={error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'};
app.get('/api/convenio-firma/:t',rateLimit({windowMs:15*60e3,limit:120}),wrap(async(req,res)=>{const c=await cvTok(req.params.t);if(!c)return res.status(404).json(cvNo);res.json(cvOut(c))}));
app.get('/api/convenio-firma/:t/docx',rateLimit({windowMs:15*60e3,limit:60}),wrap(async(req,res)=>{const c=await cvTok(req.params.t);if(!c)return res.status(404).json(cvNo);const d=JSON.parse(c.datos);docxRes(res,cvDocx(c),d.f.obra)}));
app.post('/api/convenio-firma/:t',rateLimit({windowMs:60*60e3,limit:30}),wrap(async(req,res)=>{const c=await cvTok(req.params.t);if(!c)return res.status(404).json(cvNo);
 if(c.rol=='inst'?c.inst_fecha:c.firma_fecha)return res.status(409).json({error:'Este convenio ya fue firmado.'});
 const d=req.body||{},nombre=up(txtc(d.nombre,120)).replace(/\s+/g,' '),dni=String(d.dni||'').replace(/\D/g,''),img=String(d.firma||'');
 if(!d.acepta)return res.status(400).json({error:'Tenés que marcar que firmás conforme.'});
 if(nombre.length<3)return res.status(400).json({error:'Escribí tu nombre completo.'});
 if(dni.length<6||dni.length>10)return res.status(400).json({error:'Escribí un DNI válido (solo números).'});
 if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)||img.length>2000000||Buffer.from(img.slice(22),'base64').length<1200)return res.status(400).json({error:'Dibujá tu firma en el recuadro.'});
 const hash=cvHash(JSON.parse(c.datos)),I=c.rol=='inst',r=await db.execute({sql:I?"UPDATE convenios_firma SET inst_nombre=?,inst_dni=?,inst_img=?,inst_fecha=datetime('now'),inst_ip=?,inst_hash=? WHERE inst_token=? AND inst_fecha IS NULL":"UPDATE convenios_firma SET firma_nombre=?,firma_dni=?,firma_img=?,firma_fecha=datetime('now'),firma_ip=?,firma_hash=? WHERE token=? AND firma_fecha IS NULL",args:[nombre,dni,img,String(req.ip||''),hash,req.params.t]});
 if(!r.rowsAffected)return res.status(409).json({error:'Este convenio ya fue firmado.'});
 await audit(nombre+(I?' (Instituto)':' (productora)'),'firmar','convenio',c.bordereaux_id,`DNI ${dni} · huella ${hash.slice(0,12).toUpperCase()}`);res.json({ok:1,verificacion:hash.slice(0,12).toUpperCase()})}));
/* ===== Formulario de Argentores (Form. 1003): se completa con el bordereaux y se envía a la productora para la firma ===== */
await db.execute(`CREATE TABLE IF NOT EXISTS argentores_firma(id INTEGER PRIMARY KEY,bordereaux_id INTEGER UNIQUE,token TEXT UNIQUE,datos TEXT,creado_por TEXT,creado_en TEXT DEFAULT CURRENT_TIMESTAMP,enviado_a TEXT,firma_nombre TEXT,firma_dni TEXT,firma_img TEXT,firma_fecha TEXT,firma_ip TEXT,firma_hash TEXT)`);
const argLink=(req,t)=>enlace(req,`/argentores.html?firma=${t}`);
const r2=n=>Math.round(n*100)/100;
function argBuild(x){x=x||{};const bad=m=>{throw{status:400,error:m}},t=(k,n=120)=>up(String(x[k]??'').replace(/[\r\n\t]+/g,' ').trim().slice(0,n));
 const fe=dmy(String(x.fecha_evento||'').slice(0,10));if(!fe)bad('Falta la fecha del evento');if(!t('obra'))bad('Falta la obra representada');
 const filas=[].concat(x.filas||[]).slice(0,4).map(r=>{const c=Number(r?.cant),p=Number(String(r?.precio??'').replace(',','.'));if(r?.cant===''&&r?.precio===''||r?.cant==null&&r?.precio==null)return null;if(!Number.isInteger(c)||c<0||c>1e7)bad('La cantidad de localidades tiene que ser un número entero');if(!Number.isFinite(p)||p<0||p>1e9)bad('El precio tiene que ser un número de 0 o más');return{cant:c,precio:r2(p),total:r2(c*p)}}).filter(Boolean);
 if(!filas.length)bad('Cargá al menos un renglón de localidades vendidas');
 const pct=x.pct===''||x.pct==null?10:Number(x.pct);if(!Number.isFinite(pct)||pct<0||pct>100)bad('El porcentaje de derechos de autor no es válido');
 const tot_esp=filas.reduce((s,r)=>s+r.cant,0),tot_rec=r2(filas.reduce((s,r)=>s+r.total,0)),derechos=r2(tot_rec*pct/100);
 return{f:{fecha:fe.dmy,hora:t('hora',20),obra:t('obra'),autor:t('autor'),compania:t('compania'),director:t('director'),sala:t('sala'),domicilio:t('domicilio'),localidad:t('localidad',60),provincia:t('provincia',60),telefono:t('telefono',40),email:String(x.email??'').trim().slice(0,100).toLowerCase(),cuit:t('cuit',30),fecha_iso:String(x.fecha_evento).slice(0,10)},filas,tot_esp,tot_rec,pct,derechos,inst:x.inst===1||x.inst===true||x.inst==='1'?1:0}}
const argBor=async id=>{const [b]=await q('SELECT b.id,b.numero,b.anio,e.nombre FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[id]);return b};
app.get('/api/argentores/:id/datos',adm,wrap(async(req,res)=>{const [b]=await q('SELECT b.*,e.nombre,e.fecha,e.artista FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[req.params.id]);if(!b)return res.sendStatus(404);
 const [pv]=await q('SELECT datos FROM argentores_firma ORDER BY id DESC LIMIT 1'),pf=pv?JSON.parse(pv.datos).f:{},ent=JSON.parse(b.entradas||'[]').filter(r=>r.vendidas>0&&r.precio>0);
 res.json({fecha_evento:b.fecha,hora:b.hora_inicio?b.hora_inicio+' HS':'',obra:b.nombre,autor:'',compania:b.produccion||'',director:b.produccion||'',sala:pf.sala||'CENTRO CULTURAL ALTERNATIVO',domicilio:pf.domicilio||'SANTA MARÍA DE ORO 471',localidad:pf.localidad||'RESISTENCIA',provincia:pf.provincia||'CHACO',telefono:pf.telefono||'',email:pf.email||'cecualeros.adm@gmail.com',cuit:pf.cuit||'',
  filas:ent.slice(0,4).map(r=>({cant:r.vendidas,precio:r.precio})),pct:b.argentores_pct??10,inst:0,aviso:ent.length>4?`El bordereaux tiene ${ent.length} tipos de entrada con precio y el formulario tiene 4 renglones: se cargaron los primeros 4. Corregilos a mano si hace falta.`:''})}));
app.get('/api/argentores/:id/estado',adm,wrap(async(req,res)=>{const [c]=await q('SELECT token,enviado_a,firma_nombre,firma_dni,firma_fecha FROM argentores_firma WHERE bordereaux_id=?',[+req.params.id]);
 if(!c)return res.json({existe:false});res.json({existe:true,firmado:!!c.firma_fecha,firma_nombre:c.firma_nombre,firma_dni:c.firma_dni,firma_fecha:c.firma_fecha,enviado_a:c.enviado_a,link:c.firma_fecha?null:argLink(req,c.token)})}));
function argMail(to,d,link){mail(to,`Formulario de Argentores: ${d.f.obra}`,`<div style="font-family:Arial,sans-serif;max-width:520px"><p>Hola${d.f.compania?' '+esc(d.f.compania):''},</p><p>El Centro Cultural Alternativo te envía el <b>bordereaux de Argentores (Form. 1003)</b> de ${esc(d.f.obra)} (${esc(d.f.fecha)}) para que lo revises y lo firmes.</p><p><a href="${link}" style="background:#0f6b63;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Revisar y firmar</a></p><p>Se abre desde el celular o la computadora: firmás con el dedo o el mouse y completás tu nombre y DNI.</p><p>Saludos 🙌</p></div>`)}
app.post('/api/argentores/:id/firma-link',adm,wrap(async(req,res)=>{const id=+req.params.id,b=await argBor(id);if(!b)return res.sendStatus(404);
 const to=String(req.body?.mail||'').trim();if(to&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))return res.status(400).json({error:'El mail no es válido'});
 const d=argBuild(req.body),[c]=await q('SELECT id,token,firma_fecha FROM argentores_firma WHERE bordereaux_id=?',[id]);
 if(c?.firma_fecha)return res.status(409).json({error:'El formulario ya está firmado. Anulá la firma si hay que corregirlo.'});
 let t=c?.token;if(!c){t=tkn();await q('INSERT INTO argentores_firma(bordereaux_id,token,datos,creado_por) VALUES(?,?,?,?)',[id,t,JSON.stringify(d),req.u.nombre])}
 else{if(req.body.nuevo)t=tkn();await q('UPDATE argentores_firma SET token=?,datos=?,creado_por=? WHERE id=?',[t,JSON.stringify(d),req.u.nombre,c.id])}
 const link=argLink(req,t);if(to){argMail(to,d,link);await q('UPDATE argentores_firma SET enviado_a=? WHERE bordereaux_id=?',[to,id])}
 await audit(req.u.nombre,to?'enviar a firmar':'guardar','argentores',id,`Nº ${b.numero}/${b.anio} · ${b.nombre}${to?' → '+to:''}`);res.json({link,mail:!!to})}));
app.delete('/api/argentores/:id/firma',adm,wrap(async(req,res)=>{const id=+req.params.id,r=await db.execute({sql:'DELETE FROM argentores_firma WHERE bordereaux_id=?',args:[id]});if(!r.rowsAffected)return res.sendStatus(404);await audit(req.u.nombre,'anular formulario/firma','argentores',id);res.json({ok:1})}));
const argOut=c=>{const d=JSON.parse(c.datos);return{...d,inst_img:d.inst?FIRMA_INST:null,firmado:!!c.firma_fecha,firma_nombre:c.firma_nombre,firma_dni:c.firma_dni,firma_img:c.firma_fecha?c.firma_img:null,firma_fecha:c.firma_fecha,verificacion:c.firma_hash?c.firma_hash.slice(0,12).toUpperCase():null}};
app.get('/api/argentores/:id/ficha',adm,wrap(async(req,res)=>{const [c]=await q('SELECT * FROM argentores_firma WHERE bordereaux_id=?',[+req.params.id]);if(!c)return res.status(404).json({error:'Todavía no se guardó este formulario.'});res.json(argOut(c))}));
const argTok=async t=>{if(!/^[a-f0-9]{48}$/.test(String(t)))return null;const [c]=await q('SELECT * FROM argentores_firma WHERE token=?',[t]);return c||null};
const argNo={error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'};
app.get('/api/argentores-firma/:t',rateLimit({windowMs:15*60e3,limit:120}),wrap(async(req,res)=>{const c=await argTok(req.params.t);if(!c)return res.status(404).json(argNo);res.json(argOut(c))}));
app.post('/api/argentores-firma/:t',rateLimit({windowMs:60*60e3,limit:30}),wrap(async(req,res)=>{const c=await argTok(req.params.t);if(!c)return res.status(404).json(argNo);
 if(c.firma_fecha)return res.status(409).json({error:'Este formulario ya fue firmado.'});
 const d=req.body||{},nombre=up(txtc(d.nombre,120)).replace(/\s+/g,' '),dni=String(d.dni||'').replace(/\D/g,''),img=String(d.firma||'');
 if(!d.acepta)return res.status(400).json({error:'Tenés que marcar que firmás conforme.'});
 if(nombre.length<3)return res.status(400).json({error:'Escribí tu nombre completo.'});
 if(dni.length<6||dni.length>10)return res.status(400).json({error:'Escribí un DNI válido (solo números).'});
 if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)||img.length>2000000||Buffer.from(img.slice(22),'base64').length<1200)return res.status(400).json({error:'Dibujá tu firma en el recuadro.'});
 const hash=crypto.createHash('sha256').update(c.datos).digest('hex'),r=await db.execute({sql:"UPDATE argentores_firma SET firma_nombre=?,firma_dni=?,firma_img=?,firma_fecha=datetime('now'),firma_ip=?,firma_hash=? WHERE token=? AND firma_fecha IS NULL",args:[nombre,dni,img,String(req.ip||''),hash,req.params.t]});
 if(!r.rowsAffected)return res.status(409).json({error:'Este formulario ya fue firmado.'});
 await audit(nombre+' (productora)','firmar','argentores',c.bordereaux_id,`DNI ${dni} · huella ${hash.slice(0,12).toUpperCase()}`);res.json({ok:1,verificacion:hash.slice(0,12).toUpperCase()})}));
app.get('/api/bordereaux/siguiente',adm,wrap(async(req,res)=>{const anio=+req.query.anio||new Date().getFullYear();
 const [n]=await q('SELECT MAX(numero) m FROM bordereaux WHERE anio=?',[anio]),[l]=await q('SELECT resolucion,interviene FROM bordereaux ORDER BY id DESC LIMIT 1');
 res.json({numero:(n.m||0)+1,resolucion:l?.resolucion||'',interviene:l?.interviene||'',ich_pct:ICH_PCT})}));
app.get('/api/bordereaux',adm,wrap(async(req,res)=>res.json(await q('SELECT b.id,b.anio,b.numero,b.total_recaudado,b.total_publico,b.para_ich,b.firma_nombre,b.firma_fecha,b.firma_token IS NOT NULL AS enviado,e.nombre,e.fecha FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id ORDER BY e.fecha DESC,b.numero DESC'))));
app.get('/api/bordereaux/:id',adm,wrap(async(req,res)=>{
 const [b]=await q('SELECT b.*,e.nombre,e.fecha,e.artista,e.franjas FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[req.params.id]);if(!b)return res.sendStatus(404);
 b.entradas=JSON.parse(b.entradas||'[]');b.franjas=(b.franjas||'').split(',').filter(Boolean);delete b.firma_token;delete b.firma_ip;b.icch_img=b.firma_icch?FIRMA_INST:null;res.json(b)}));
app.post('/api/bordereaux',adm,(req,res)=>saveBor(req,res,null));
app.put('/api/bordereaux/:id',adm,(req,res)=>saveBor(req,res,+req.params.id));
app.delete('/api/bordereaux/:id',adm,wrap(async(req,res)=>{const id=+req.params.id;
 const [b]=await q('SELECT b.numero,b.anio,b.evento_id,b.firma_fecha,e.nombre FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[id]);if(!b)return res.sendStatus(404);
 if(b.firma_fecha)return res.status(409).json({error:'El bordereaux está firmado. Primero anulá la firma si realmente querés eliminarlo.'});
 const con=req.query.evento==='1';
 await db.batch([{sql:'DELETE FROM bordereaux WHERE id=?',args:[id]},...(con?[{sql:'DELETE FROM eventos_puntuales WHERE id=?',args:[b.evento_id]}]:[])],'write');
 await audit(req.u.nombre,'eliminar','bordereaux',id,`Nº ${b.numero}/${b.anio} · ${b.nombre}`);
 if(con)await audit(req.u.nombre,'eliminar','evento',b.evento_id,b.nombre);
 res.json({ok:1})}));

/* ===== Firma de la productora (firma electrónica manuscrita: dibuja con mouse o dedo, escribe nombre y DNI) =====
   El administrador genera un link; la productora lo abre, revisa el bordereaux y firma. Se guarda la imagen de la firma, nombre, DNI, fecha, IP y una huella (SHA-256) del contenido. */
const origen=req=>`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host}`;
const bHash=b=>crypto.createHash('sha256').update(JSON.stringify([b.anio,b.numero,b.nombre,b.fecha,b.artista,b.hora_inicio,b.hora_cierre,b.actividad,b.produccion,b.cuit,b.telefono,b.domicilio,b.resolucion,b.entradas,b.sadaic_pct,b.argentores_pct,b.ich_pct,b.total_recaudado,b.total_publico,b.total_invitados,b.ret_sadaic,b.ret_argentores,b.ret_total,b.para_ich,b.para_productora,b.fecha_pago_ret,b.liq_fecha,b.liq_hora,b.interviene])).digest('hex');
async function porToken(t){if(!/^[a-f0-9]{48}$/.test(String(t)))return null;
 const [b]=await q('SELECT b.*,e.nombre,e.fecha,e.artista FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.firma_token=?',[t]);return b||null}
app.post('/api/bordereaux/:id/firma-link',adm,wrap(async(req,res)=>{const id=+req.params.id,[b]=await q('SELECT b.id,b.numero,b.anio,b.firma_token,b.firma_fecha,e.nombre FROM bordereaux b JOIN eventos_puntuales e ON e.id=b.evento_id WHERE b.id=?',[id]);if(!b)return res.sendStatus(404);
 if(b.firma_fecha)return res.status(409).json({error:'Este bordereaux ya está firmado.'});
 let t=b.firma_token;if(!t||req.body.nuevo){t=crypto.randomBytes(24).toString('hex');await q('UPDATE bordereaux SET firma_token=? WHERE id=?',[t,id])}
 const link=enlace(req,`/bordereaux.html?firma=${t}`),mailTo=String(req.body.mail||'').trim();
 if(mailTo){if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailTo))return res.status(400).json({error:'El mail no es válido'});
  mail(mailTo,`Bordereaux Nº ${b.numero}/${b.anio} para firmar`,`<div style="font-family:Arial,sans-serif;max-width:520px"><p>Hola,</p><p>El Centro Cultural Alternativo te envía el <b>bordereaux Nº ${b.numero}/${b.anio}</b> del evento <b>${esc(b.nombre)}</b> para que lo revises y lo firmes.</p><p><a href="${link}" style="background:#0f6b63;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Revisar y firmar</a></p><p>Se abre desde el celular o la computadora: firmás con el dedo o el mouse y completás tu nombre y DNI.</p><p>Saludos 🙌</p></div>`)}
 await audit(req.u.nombre,mailTo?'enviar a firmar':'generar link de firma','bordereaux',id,`Nº ${b.numero}/${b.anio}${mailTo?' → '+mailTo:''}`);res.json({link,mail:!!mailTo})}));
app.delete('/api/bordereaux/:id/firma',adm,wrap(async(req,res)=>{const id=+req.params.id,r=await db.execute({sql:'UPDATE bordereaux SET firma_token=NULL,firma_nombre=NULL,firma_dni=NULL,firma_img=NULL,firma_fecha=NULL,firma_ip=NULL,firma_hash=NULL WHERE id=?',args:[id]});
 if(!r.rowsAffected)return res.sendStatus(404);await audit(req.u.nombre,'anular firma','bordereaux',id);res.json({ok:1})}));
app.get('/api/firma/:t',rateLimit({windowMs:15*60e3,limit:120}),wrap(async(req,res)=>{const b=await porToken(req.params.t);if(!b)return res.status(404).json({error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'});
 b.entradas=JSON.parse(b.entradas||'[]');b.icch_img=b.firma_icch?FIRMA_INST:null;b.firmado=!!b.firma_fecha;b.verificacion=b.firma_hash?b.firma_hash.slice(0,12).toUpperCase():null;
 for(const k of ['firma_token','firma_ip','firma_hash','creado_por','id','evento_id'])delete b[k];res.json(b)}));
app.post('/api/firma/:t',rateLimit({windowMs:60*60e3,limit:30}),wrap(async(req,res)=>{const b=await porToken(req.params.t);if(!b)return res.status(404).json({error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'});
 if(b.firma_fecha)return res.status(409).json({error:'Este bordereaux ya fue firmado.'});
 const d=req.body||{},nombre=up(txtc(d.nombre,120)).replace(/\s+/g,' '),dni=String(d.dni||'').replace(/\D/g,''),img=String(d.firma||'');
 if(!d.acepta)return res.status(400).json({error:'Tenés que marcar que firmás conforme.'});
 if(nombre.length<3)return res.status(400).json({error:'Escribí tu nombre completo.'});
 if(dni.length<6||dni.length>10)return res.status(400).json({error:'Escribí un DNI válido (solo números).'});
 if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)||img.length>2000000||Buffer.from(img.slice(22),'base64').length<1200)return res.status(400).json({error:'Dibujá tu firma en el recuadro.'});
 b.entradas=JSON.parse(b.entradas||'[]');const hash=bHash(b);
 const r=await db.execute({sql:"UPDATE bordereaux SET firma_nombre=?,firma_dni=?,firma_img=?,firma_fecha=datetime('now'),firma_ip=?,firma_hash=? WHERE firma_token=? AND firma_fecha IS NULL",args:[nombre,dni,img,String(req.ip||''),hash,req.params.t]});
 if(!r.rowsAffected)return res.status(409).json({error:'Este bordereaux ya fue firmado.'});
 await audit(nombre+' (productora)','firmar','bordereaux',b.id,`Nº ${b.numero}/${b.anio} · DNI ${dni} · huella ${hash.slice(0,12).toUpperCase()}`);res.json({ok:1,verificacion:hash.slice(0,12).toUpperCase()})}));

/* ===== Planillas (solo administrador) =====
   Inscriptos: se genera al pedirla (no se guarda). Asistencia: se genera con las fechas de clase del período, todos presentes.
   Solo si se la envía al tallerista para firmar se conserva una copia de esa planilla + su firma (se puede borrar cuando se descargó). */
const DIAS_N={lunes:1,martes:2,miercoles:3,jueves:4,viernes:5,sabado:6,domingo:0,lun:1,mar:2,mie:3,jue:4,vie:5,sab:6,dom:0};
const sinTilde=t=>String(t||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
function parseDias(t){const w=sinTilde(t).replace(/[^a-z]+/g,' ').split(' ').filter(Boolean),set=new Set();
 for(let i=0;i<w.length;i++){const d=DIAS_N[w[i]];if(d===undefined)continue;
  if((w[i+1]==='a'||w[i+1]==='al')&&DIAS_N[w[i+2]]!==undefined){let a=d;const b=DIAS_N[w[i+2]];for(let n=0;n<8;n++){set.add(a);if(a===b)break;a=(a+1)%7}i+=2}else set.add(d)}
 return [...set].sort((a,b)=>((a+6)%7)-((b+6)%7))}
const ISO=/^\d{4}-\d{2}-\d{2}$/,iso=d=>d.toISOString().slice(0,10),hoyAR=()=>iso(new Date(Date.now()-3*3600e3));
const MESES3=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function rango(x){let desde,hasta;
 if(/^\d{4}-\d{2}$/.test(String(x.mes||''))){const [y,m]=x.mes.split('-').map(Number);if(m<1||m>12)throw{status:400,error:'Mes inválido'};desde=`${x.mes}-01`;hasta=iso(new Date(Date.UTC(y,m,0)))}
 else{desde=String(x.desde||'');hasta=String(x.hasta||'');if(!ISO.test(desde)||!ISO.test(hasta)||isNaN(new Date(desde))||isNaN(new Date(hasta)))throw{status:400,error:'Elegí un mes o las fechas desde y hasta.'}}
 if(hasta<desde)throw{status:400,error:'La fecha "hasta" no puede ser anterior a "desde".'};
 if((new Date(hasta)-new Date(desde))/864e5>400)throw{status:400,error:'El período no puede superar 13 meses.'};
 return{desde,hasta}}
function fechasClase(dias,desde,hasta){const out=[],e=new Date(hasta+'T00:00:00Z');for(let d=new Date(desde+'T00:00:00Z');d<=e;d=new Date(d.getTime()+864e5))if(dias.includes(d.getUTCDay()))out.push(iso(d));return out}
async function actPl(id){id=+id;const [a]=id?await q('SELECT id,nombre,periodo,dias,horarios,tallerista_nombre,tallerista_contacto,tallerista_dni FROM actividades WHERE id=?',[id]):[];if(!a)throw{status:404,error:'Elegí una actividad.'};return a}
async function alumnosPl(id,pend){const r=await q(`SELECT nombre,dni,fecha_nac,barrio,localidad,mail FROM inscripciones WHERE actividad_id=? ${pend?'':"AND estado!='pendiente'"}`,[id]);return r.sort((a,b)=>String(a.nombre).localeCompare(String(b.nombre),'es'))}
const edadDe=(fn,ref)=>{if(!ISO.test(fn||''))return '';const [a,m,d]=fn.split('-').map(Number),[A,M,D]=ref.split('-').map(Number);let e=A-a;if(M<m||(M===m&&D<d))e--;return e>=0&&e<120?e:''};
async function buildIns(x){const a=await actPl(x.actividad),pend=x.pend==='1'||x.pend===true,mes=/^\d{4}-\d{2}$/.test(String(x.mes||''))?x.mes:hoyAR().slice(0,7),ref=hoyAR();
 const al=await alumnosPl(a.id,pend);
 return{tipo:'ins',taller:a.nombre,periodo:a.periodo||'',tallerista:a.tallerista_nombre||'',mes_anio:`${MESES3[+mes.slice(5)-1]}-${mes.slice(0,4)}`,
  alumnos:al.map(r=>({nombre:r.nombre,dni:r.dni,edad:edadDe(r.fecha_nac,ref),barrio:r.barrio||'',localidad:r.localidad||'',mail:r.mail||''}))}}
async function buildAsi(x){const a=await actPl(x.actividad),pend=x.pend==='1'||x.pend===true,{desde,hasta}=rango(x),dias=parseDias(a.dias);
 if(!dias.length)throw{status:400,error:`No pude leer los días de «${a.nombre}». Editá la actividad y escribí los días, por ejemplo: «Martes y jueves».`};
 let fechas=fechasClase(dias,desde,hasta);
 if(x.fechas!==undefined&&x.fechas!==null){const sel=new Set(String(x.fechas).split(',').filter(f=>ISO.test(f)));fechas=fechas.filter(f=>sel.has(f))}
 if(!fechas.length)throw{status:400,error:'No hay clases para ese período (revisá los días de la actividad o las fechas elegidas).'};
 const al=await alumnosPl(a.id,pend);
 return{tipo:'asi',actividad_id:a.id,taller:a.nombre,periodo:a.periodo||'',tallerista:a.tallerista_nombre||'',dias_horarios:[a.dias,a.horarios].filter(Boolean).join(' · '),desde,hasta,fechas,alumnos:al.map(r=>r.nombre)}}
const plHash=d=>crypto.createHash('sha256').update(JSON.stringify([d.taller,d.tallerista,d.dias_horarios,d.desde,d.hasta,d.fechas,d.alumnos])).digest('hex');
const conIcch=d=>{d.icch_img=d.icch?FIRMA_INST:null;return d};
app.get('/api/planillas/inscriptos',adm,wrap(async(req,res)=>res.json(conIcch({...await buildIns(req.query),icch:req.query.icch==='1'?1:0}))));
app.get('/api/planillas/asistencia',adm,wrap(async(req,res)=>res.json(conIcch({...await buildAsi(req.query),icch:req.query.icch==='1'?1:0}))));
app.get('/api/planillas/fechas',adm,wrap(async(req,res)=>{const a=await actPl(req.query.actividad),{desde,hasta}=rango(req.query),dias=parseDias(a.dias);
 if(!dias.length)throw{status:400,error:`No pude leer los días de «${a.nombre}». Editá la actividad y escribí los días, por ejemplo: «Martes y jueves».`};
 const [c]=await q(`SELECT COUNT(*) n,COALESCE(SUM(estado!='pendiente'),0) conf FROM inscripciones WHERE actividad_id=?`,[a.id]);
 res.json({fechas:fechasClase(dias,desde,hasta),inscriptos:c.conf,total:c.n,tallerista:a.tallerista_nombre||'',contacto:a.tallerista_contacto||''})}));
/* Envío al tallerista para firmar */
const plLink=(req,t)=>enlace(req,`/planilla.html?firma=${t}`);
function plMail(to,d,link){mail(to,`Planilla de asistencia: ${d.taller}`,`<div style="font-family:Arial,sans-serif;max-width:520px"><p>Hola${d.tallerista?' '+esc(d.tallerista):''},</p><p>El Centro Cultural Alternativo te envía la <b>planilla de asistencia</b> de <b>${esc(d.taller)}</b> (${esc(d.desde.split('-').reverse().join('/'))} al ${esc(d.hasta.split('-').reverse().join('/'))}) para que la revises y la firmes.</p><p><a href="${link}" style="background:#0f6b63;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Revisar y firmar</a></p><p>Se abre desde el celular o la computadora: firmás con el dedo o el mouse y completás tu nombre y DNI.</p><p>Saludos 🙌</p></div>`)}
app.post('/api/planillas/envios',adm,wrap(async(req,res)=>{const b=req.body||{},d=await buildAsi({actividad:b.actividad,mes:b.mes,desde:b.desde,hasta:b.hasta,fechas:Array.isArray(b.fechas)?b.fechas.join(','):'',pend:b.pend?'1':'0'});
 const t=crypto.randomBytes(24).toString('hex'),r=await db.execute({sql:'INSERT INTO planillas_firma(token,actividad_id,taller,tallerista,desde,hasta,datos,creado_por) VALUES(?,?,?,?,?,?,?,?)',args:[t,d.actividad_id,d.taller,d.tallerista,d.desde,d.hasta,JSON.stringify({...d,icch:b.icch?1:0}),req.u.nombre]});
 const id=Number(r.lastInsertRowid);await audit(req.u.nombre,'generar link de firma','planilla asistencia',id,`${d.taller} · ${d.desde} a ${d.hasta}`);res.json({id,link:plLink(req,t)})}));
app.get('/api/planillas/envios',adm,wrap(async(req,res)=>{const r=await q('SELECT id,token,taller,tallerista,desde,hasta,creado_por,creado_en,enviado_a,firma_nombre,firma_fecha FROM planillas_firma ORDER BY id DESC LIMIT 100');
 res.json(r.map(x=>{const o={...x,link:x.firma_fecha?null:plLink(req,x.token)};delete o.token;return o}))}));
app.post('/api/planillas/envios/:id/link',adm,wrap(async(req,res)=>{const id=+req.params.id,[p]=await q('SELECT id,token,datos,firma_fecha FROM planillas_firma WHERE id=?',[id]);if(!p)return res.sendStatus(404);
 if(p.firma_fecha)return res.status(409).json({error:'Esta planilla ya está firmada.'});
 let t=p.token;if(req.body.nuevo){t=crypto.randomBytes(24).toString('hex');await q('UPDATE planillas_firma SET token=? WHERE id=?',[t,id])}
 const link=plLink(req,t),to=String(req.body.mail||'').trim();
 if(to){if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))return res.status(400).json({error:'El mail no es válido'});plMail(to,JSON.parse(p.datos),link);await q('UPDATE planillas_firma SET enviado_a=? WHERE id=?',[to,id]);await audit(req.u.nombre,'enviar a firmar','planilla asistencia',id,'→ '+to)}
 res.json({link,mail:!!to})}));
const plOut=p=>{const d=JSON.parse(p.datos);d.icch_img=d.icch?FIRMA_INST:null;d.firmado=!!p.firma_fecha;if(p.firma_fecha){d.firma_nombre=p.firma_nombre;d.firma_dni=p.firma_dni;d.firma_img=p.firma_img;d.firma_fecha=p.firma_fecha;d.verificacion=p.firma_hash?p.firma_hash.slice(0,12).toUpperCase():null}return d};
app.get('/api/planillas/envios/:id',adm,wrap(async(req,res)=>{const [p]=await q('SELECT * FROM planillas_firma WHERE id=?',[+req.params.id]);if(!p)return res.status(404).json({error:'No se encontró la planilla.'});res.json(plOut(p))}));
app.delete('/api/planillas/envios/:id',adm,wrap(async(req,res)=>{const id=+req.params.id,r=await db.execute({sql:'DELETE FROM planillas_firma WHERE id=?',args:[id]});if(!r.rowsAffected)return res.sendStatus(404);await audit(req.u.nombre,'eliminar','planilla asistencia',id);res.json({ok:1})}));
/* Lo que ve y firma el tallerista (link con clave larga, sin usuario) */
const plTok=async t=>{if(!/^[a-f0-9]{48}$/.test(String(t)))return null;const [p]=await q('SELECT * FROM planillas_firma WHERE token=?',[t]);return p||null};
app.get('/api/planilla-firma/:t',rateLimit({windowMs:15*60e3,limit:120}),wrap(async(req,res)=>{const p=await plTok(req.params.t);if(!p)return res.status(404).json({error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'});res.json(plOut(p))}));
app.post('/api/planilla-firma/:t',rateLimit({windowMs:60*60e3,limit:30}),wrap(async(req,res)=>{const p=await plTok(req.params.t);if(!p)return res.status(404).json({error:'El link no es válido o fue reemplazado. Pedí uno nuevo.'});
 if(p.firma_fecha)return res.status(409).json({error:'Esta planilla ya fue firmada.'});
 const d=req.body||{},nombre=up(txtc(d.nombre,120)).replace(/\s+/g,' '),dni=String(d.dni||'').replace(/\D/g,''),img=String(d.firma||'');
 if(!d.acepta)return res.status(400).json({error:'Tenés que marcar que firmás conforme.'});
 if(nombre.length<3)return res.status(400).json({error:'Escribí tu nombre completo.'});
 if(dni.length<6||dni.length>10)return res.status(400).json({error:'Escribí un DNI válido (solo números).'});
 if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)||img.length>2000000||Buffer.from(img.slice(22),'base64').length<1200)return res.status(400).json({error:'Dibujá tu firma en el recuadro.'});
 const hash=plHash(JSON.parse(p.datos)),r=await db.execute({sql:"UPDATE planillas_firma SET firma_nombre=?,firma_dni=?,firma_img=?,firma_fecha=datetime('now'),firma_ip=?,firma_hash=? WHERE token=? AND firma_fecha IS NULL",args:[nombre,dni,img,String(req.ip||''),hash,req.params.t]});
 if(!r.rowsAffected)return res.status(409).json({error:'Esta planilla ya fue firmada.'});
 await audit(nombre+' (tallerista)','firmar','planilla asistencia',p.id,`${p.taller} · DNI ${dni} · huella ${hash.slice(0,12).toUpperCase()}`);res.json({ok:1,verificacion:hash.slice(0,12).toUpperCase()})}));

/* Usuarios (solo super) */
app.get('/api/usuarios',sup,wrap(async(req,res)=>res.json(await q('SELECT id,nombre,usuario,rol,activo FROM usuarios ORDER BY id'))));
app.post('/api/usuarios',sup,wrap(async(req,res)=>{const u=req.body;
 if(!u.nombre||!u.usuario||(u.clave||'').length<6)return res.status(400).json({error:'Completá nombre, usuario y una clave de al menos 6 caracteres'});
 if(!['ap','adm','super'].includes(u.rol))return res.status(400).json({error:'Rol inválido'});
 if((await q('SELECT 1 FROM usuarios WHERE usuario=?',[u.usuario.trim()])).length)return res.status(409).json({error:'Ese usuario ya existe'});
 await q('INSERT INTO usuarios(nombre,usuario,clave_hash,rol) VALUES(?,?,?,?)',[u.nombre,u.usuario.trim(),bcrypt.hashSync(u.clave,10),u.rol]);
 await audit(req.u.nombre,'crear','usuario',0,`${u.usuario} (${u.rol})`);res.json({ok:1})}));
app.patch('/api/usuarios/:id',sup,wrap(async(req,res)=>{const b=req.body,id=+req.params.id;
 if(!(await q('SELECT 1 FROM usuarios WHERE id=?',[id])).length)return res.sendStatus(404);
 if(b.rol!==undefined){if(!['ap','adm','super'].includes(b.rol))return res.status(400).json({error:'Rol inválido'});if(id===req.u.id)return res.status(400).json({error:'No podés cambiar tu propio rol'});await q('UPDATE usuarios SET rol=? WHERE id=?',[b.rol,id]);await audit(req.u.nombre,'cambiar rol','usuario',id,b.rol)}
 if(b.clave!==undefined){if(b.clave.length<6)return res.status(400).json({error:'La clave debe tener al menos 6 caracteres'});await q('UPDATE usuarios SET clave_hash=? WHERE id=?',[bcrypt.hashSync(b.clave,10),id]);await audit(req.u.nombre,'cambiar clave','usuario',id)}
 if(b.activo!==undefined){if(id===req.u.id)return res.status(400).json({error:'No podés desactivar tu propio usuario'});await q('UPDATE usuarios SET activo=? WHERE id=?',[b.activo?1:0,id]);await audit(req.u.nombre,b.activo?'activar':'desactivar','usuario',id)}
 res.json({ok:1})}));

/* Excel por actividad */
app.get('/api/export/inscriptos.xlsx',ap,wrap(async(req,res)=>{
 const rows=(await q('SELECT i.*,a.nombre AS actividad,a.periodo,a.estado AS actividad_estado,u.nombre AS cargado_por FROM inscripciones i JOIN actividades a ON a.id=i.actividad_id LEFT JOIN usuarios u ON u.id=i.creado_por WHERE (?1 IS NULL OR i.actividad_id=?1) ORDER BY a.nombre,i.nombre',[req.query.actividad||null])).map(r=>({...r,actividad_estado:r.actividad_estado==='suspendida'?'Suspendida':'Activa',cargo:r.origen==='web'?'Web':(r.cargado_por||''),fecha:fmtAR(r.creado_en)}));
 const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Inscriptos');
 ws.columns=[['actividad','Actividad',28],['periodo','Período',20],['actividad_estado','Estado de la actividad',14],['nombre','Nombre completo',28],['dni','DNI',12],['fecha_nac','Fecha de nacimiento',16],['tutor_nombre','Tutor/a',26],['mail','Mail',28],['whatsapp','WhatsApp',16],['direccion','Dirección',26],['barrio','Barrio',18],['localidad','Localidad',18],['provincia','Provincia',14],['metodo_pago','Método de pago',16],['monto','Monto',12],['estado','Estado',12],['fecha','Fecha de carga',18],['cargo','Cargó',22]].map(([key,header,width])=>({key,header,width}));
 ws.addRows(rows);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename=inscriptos.xlsx');await wb.xlsx.write(res);res.end()}));

/* Dashboard (incluye pendientes) */
app.get('/api/dashboard',adm,wrap(async(req,res)=>{
 const porAct=await q(`SELECT a.id,a.nombre,a.periodo,a.estado,a.tipo,COUNT(i.id) inscriptos,COALESCE(SUM(i.estado!='pendiente'),0) confirmados,COALESCE(SUM(i.monto),0) monto,COALESCE(SUM(i.estado='pendiente'),0) pendientes,COALESCE(SUM(CASE WHEN i.estado!='pendiente' THEN i.monto END),0) monto_confirmado,COALESCE(SUM(CASE WHEN i.estado='pendiente' THEN i.monto END),0) monto_pendiente FROM actividades a LEFT JOIN inscripciones i ON i.actividad_id=a.id GROUP BY a.id ORDER BY a.nombre`);
 const [tot]=await q(`SELECT COUNT(*) total,SUM(estado='pendiente') pendientes,SUM(estado!='pendiente') confirmados,COALESCE(SUM(CASE WHEN estado!='pendiente' THEN monto END),0) monto_confirmado,COALESCE(SUM(CASE WHEN estado='pendiente' THEN monto END),0) monto_pendiente,COALESCE(SUM(origen='web'),0) web,COALESCE(SUM(origen!='web'),0) sistema FROM inscripciones`);
 const edades={'Menos de 6':0,'6 a 11':0,'12 a 17':0,'18 a 24':0,'25 a 35':0,'36 a 55':0,'Más de 55':0};(await q('SELECT fecha_nac FROM inscripciones')).forEach(r=>{const a=edad(r.fecha_nac);edades[a<6?'Menos de 6':a<12?'6 a 11':a<18?'12 a 17':a<25?'18 a 24':a<36?'25 a 35':a<=55?'36 a 55':'Más de 55']++});
 /* Los meses se cuentan con hora argentina (UTC-3): una inscripción de las 22 hs del 31 no pasa al mes siguiente */
 const meses=await q(`SELECT strftime('%Y-%m',datetime(creado_en,'-3 hours')) mes,COUNT(*) inscripciones,COALESCE(SUM(monto),0) monto,SUM(estado='pendiente') pendientes,SUM(origen='web') web,SUM(origen!='web') sistema FROM inscripciones WHERE creado_en IS NOT NULL GROUP BY mes ORDER BY mes`);
 const tipos=await q(`SELECT a.tipo,COUNT(i.id) n FROM inscripciones i JOIN actividades a ON a.id=i.actividad_id GROUP BY a.tipo ORDER BY n DESC`);
 const eventos=await q(`SELECT id,nombre,fecha,asistentes,monto,franjas FROM eventos_puntuales ORDER BY fecha`);
 /* Barrio es texto libre: se unifica sin tildes ni mayúsculas/espacios de más para que "Villa  Crespo" y "villa crespo" cuenten juntos */
 const nb=s=>String(s||'').toUpperCase().normalize('NFD').replace(/N\u0303/g,'\u00D1').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9\u00D1 ]/g,' ').replace(/\s+/g,' ').trim(),bm={};let sinBarrio=0;
 (await q('SELECT barrio FROM inscripciones')).forEach(r=>{const k=nb(r.barrio);if(!k)sinBarrio++;else bm[k]=(bm[k]||0)+1});
 const barrios=Object.entries(bm).map(([k,n])=>({b:k.toLowerCase().replace(/(^| )\S/g,c=>c.toUpperCase()),n})).sort((a,b)=>b.n-a.n||a.b.localeCompare(b.b,'es'));
 /* Por día (hora argentina) para filtrar los gráficos por mes o rango de fechas */
 const porDia=await q("SELECT actividad_id a,date(creado_en,'-3 hours') d,SUM(estado!='pendiente') c,SUM(estado='pendiente') p,COALESCE(SUM(CASE WHEN estado!='pendiente' THEN monto END),0) mc,COALESCE(SUM(CASE WHEN estado='pendiente' THEN monto END),0) mp FROM inscripciones WHERE creado_en IS NOT NULL GROUP BY a,d");
 res.json({tot,porAct,porDia,edades,meses,tipos,eventos,barrios,sinBarrio})}));

/* Autoinscripción pública: siempre pendiente */
app.get('/api/public/actividades',wrap(async(req,res)=>res.json({whatsapp:E.WHATSAPP_CONTACTO,actividades:(await q("SELECT id,nombre,dias,horarios,arancel,tipo FROM actividades WHERE estado='activa'")).sort((x,y)=>String(x.nombre).localeCompare(String(y.nombre),'es',{sensitivity:'base',numeric:true}))})));
app.post('/api/public/inscripcion',rateLimit({windowMs:60*60e3,limit:15}),(req,res)=>{
 req.body.cupon='';// la web pública no admite cupones
 if(!req.body.acepta)return res.status(400).json({error:'Tenés que aceptar el tratamiento de datos'});
 crear(req.body,'web',{nombre:'Autoinscripción web'}).then(r=>res.json({creadas:r,whatsapp:E.WHATSAPP_CONTACTO})).catch(e=>fail(res,e))});
app.get('/inscripcion',(req,res)=>res.sendFile('inscripcion.html',{root:'public'}));
app.get('/api/health',(req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Cache-Control','no-store');res.json({ok:1})});
app.listen(E.PORT||3000,()=>console.log('Listo'));
