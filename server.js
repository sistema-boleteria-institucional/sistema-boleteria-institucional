const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { createClient } = require('@libsql/client');
const QRCode = require('qrcode');

const scryptAsync = promisify(crypto.scrypt);

const app = express();
app.set('trust proxy', 1);

// Clave que firma los QR de las entradas. Se mantiene el valor anterior como respaldo
// para no invalidar entradas ya emitidas, pero en producción DEBE definirse HMAC_SECRET.
const HMAC_SECRET = process.env.HMAC_SECRET || 'llave-secreta-boleteria-super-segura-2026';
if (!process.env.HMAC_SECRET) {
    console.warn('⚠️  HMAC_SECRET no está definida: se usa la clave por defecto del código. Definila como variable de entorno (cambiarla invalida las entradas ya emitidas).');
}
// Clave independiente para las sesiones de usuario (derivada, no reutiliza la de los QR).
const SESSION_KEY = crypto.createHash('sha256').update('sesiones:' + HMAC_SECRET).digest();
const SESION_HORAS = 12;

// Middlewares
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// Solo se publican las pantallas y recursos del sitio (antes se exponía toda la carpeta,
// incluyendo server.js, package.json y cualquier archivo de base de datos).
const ARCHIVOS_PUBLICOS = ['index.html', 'admin.html', 'entrada.html', 'puerta.html', 'style.css', 'auth.js', 'plantilla_entrada.png'];
ARCHIVOS_PUBLICOS.forEach(f => {
    app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f)));
});

// El envío de emails usa la API de Brevo (variable BREVO_API_KEY). Remitente configurable.
const MAIL_REMITENTE = process.env.MAIL_REMITENTE || 'gonzalog2019@gmail.com';
const escHtml = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Contraseñas (scrypt, sin dependencias nuevas) ----------
async function hashClave(clave) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(String(clave), salt, 64)).toString('hex');
    return `scrypt$${salt}$${hash}`;
}
function iguales(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}
// Acepta claves ya hasheadas y claves antiguas en texto plano (se migran al iniciar sesión).
async function verificarClave(clave, guardada) {
    const g = String(guardada || '');
    if (g.startsWith('scrypt$')) {
        const [, salt, hash] = g.split('$');
        if (!salt || !hash) return false;
        const calc = (await scryptAsync(String(clave), salt, 64)).toString('hex');
        return iguales(calc, hash);
    }
    return iguales(clave, g);
}
const esClaveHasheada = (g) => String(g || '').startsWith('scrypt$');

// ---------- Sesiones (token firmado, sin estado en el servidor) ----------
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function crearToken(u) {
    const payload = b64u(JSON.stringify({ id: u.id, u: u.usuario, t: String(u.tipo || '').toLowerCase(), exp: Date.now() + SESION_HORAS * 3600 * 1000 }));
    const firma = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
    return `${payload}.${firma}`;
}
function leerToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, firma] = token.split('.');
    const esperada = crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
    if (!firma || firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
    try {
        const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!d.exp || d.exp < Date.now()) return null;
        return { id: d.id, usuario: d.u, tipo: d.t };
    } catch (e) { return null; }
}

const ROLES_ADMIN = ['super', 'admin', 'adm', 'administrador'];
const ROLES_SUPER = ['super', 'admin', 'administrador'];
const ROLES_PUERTA = ['super', 'admin', 'adm', 'administrador', 'vendedor', 'puerta'];
const TIPOS_VALIDOS = ['vendedor', 'adm', 'puerta', 'super'];

function rechazar(res, status, mensaje, sesionInvalida) {
    if (sesionInvalida) res.setHeader('X-Sesion', 'invalida');
    return res.status(status).json({ exito: false, mensaje });
}

// Reglas de acceso por ruta. Todo /api requiere sesión salvo login y la entrada firmada.
function reglaDeRuta(method, p) {
    if (method === 'POST' && p === '/api/login') return 'publica';
    if (method === 'GET' && p === '/api/aviso') return 'publica';
    if (method === 'GET' && /^\/api\/entradas\/[^/]+$/.test(p)) return 'publica'; // protegida por firma HMAC
    if (p.startsWith('/api/super/')) return 'super';
    if (p === '/api/usuarios/crear') return 'admin';
    if (p === '/api/config/email-informe') return 'admin';
    if (p === '/api/eventos/crear' || p.startsWith('/api/eventos/editar/') || p.startsWith('/api/eventos/eliminar/')) return 'admin';
    if (p === '/api/cupones/crear') return 'admin';
    if (p.startsWith('/api/reportes/') || p === '/api/eventos/reporte-general') return 'admin';
    if (p === '/api/puerta/validar') return 'puerta';
    return 'usuario';
}

// Textos que se guardan siempre en mayúsculas (nombres de clientes, eventos y cupones).
const mayus = (t) => String(t == null ? '' : t).trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-AR');
const ID_EVENTO_VALIDO = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

// Devuelve un mensaje de error si los datos no son válidos; si no, normaliza req.body.
function normalizarEntrada(req) {
    const b = req.body;
    if (!b || typeof b !== 'object') return null;
    const p = req.path, m = req.method;
    const campos = (...ks) => ks.forEach(k => { if (b[k] != null) b[k] = mayus(b[k]); });
    if (m === 'POST' && p === '/api/ventas/procesar') campos('nombre', 'apellido');
    else if (m === 'PUT' && p === '/api/ventas/editar') campos('nombre', 'apellido');
    else if (m === 'PUT' && p.startsWith('/api/eventos/editar/')) campos('nombre');
    else if (m === 'POST' && p === '/api/cupones/crear') campos('codigo');
    else if (m === 'POST' && p === '/api/eventos/crear') {
        campos('nombre');
        b.id = mayus(b.id).replace(/\s+/g, '');
        if (!ID_EVENTO_VALIDO.test(b.id) || /[-_]$/.test(b.id)) {
            return 'El ID del evento no es válido. Usá letras, números y guiones (por ejemplo EV-2026-FIESTA).';
        }
    }
    return null;
}

function autenticar(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    const regla = reglaDeRuta(req.method, req.path);
    if (regla === 'publica') return next();

    const auth = req.headers.authorization || '';
    const user = leerToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!user) return rechazar(res, 401, 'Sesión no válida o vencida. Volvé a iniciar sesión.', true);

    const rol = user.tipo;
    let permitido;
    if (regla === 'super') permitido = ROLES_SUPER.includes(rol);
    else if (regla === 'admin') permitido = ROLES_ADMIN.includes(rol);
    else if (regla === 'puerta') permitido = ROLES_PUERTA.includes(rol);
    else permitido = rol !== 'puerta'; // el perfil puerta solo escanea
    if (!permitido) return rechazar(res, 403, 'No tenés permiso para realizar esta acción.');

    req.user = user;
    // El rol y el vendedor salen de la sesión, nunca de lo que envía el navegador.
    req.query.rol = rol;
    if (req.body && typeof req.body === 'object') {
        req.body.rol = rol;
        if (req.path === '/api/ventas/procesar') {
            req.body.usuario_vendedor = user.usuario;
            req.body.vendedor = user.usuario;
        }
    }
    const errorDatos = normalizarEntrada(req);
    if (errorDatos) return res.status(400).json({ exito: false, mensaje: errorDatos });
    next();
}
app.use(autenticar);

// Límite de intentos de login fallidos
const intentosLogin = new Map();
function loginBloqueado(clave) {
    const r = intentosLogin.get(clave);
    return !!r && r.n >= 8 && Date.now() - r.t < 15 * 60 * 1000;
}
function registrarFallo(clave) {
    const r = intentosLogin.get(clave);
    if (!r || Date.now() - r.t >= 15 * 60 * 1000) intentosLogin.set(clave, { n: 1, t: Date.now() });
    else r.n++;
}

// Seguridad HMAC
function generarFirma(ventaId, asientoCodigo) {
    return crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(`${ventaId}:${asientoCodigo}`)
        .digest('hex');
}

// ===== Numeración de asientos =====
// General: filas A–G de 16 asientos  → GEN-A1 … GEN-A16, GEN-B1 … GEN-B16, … GEN-G16 (112 en total).
// Gradas: cada lado (G1 / G2) tiene filas A–C de 4 asientos → G1-A1 … G1-A4, G1-B1 … G1-C4 (12 por lado, 24 en total).
// "n" es la posición del asiento dentro de su zona (1, 2, 3 …) y es lo que usan los ajustes de aforo.
const FILAS_GENERAL = 'ABCDEFG', POR_FILA_GENERAL = 16;
const FILAS_GRADA = 'ABC', POR_FILA_GRADA = 4;
function codigoGeneral(n) {
    const fila = Math.floor((n - 1) / POR_FILA_GENERAL);
    return `GEN-${FILAS_GENERAL[fila] || 'X'}${((n - 1) % POR_FILA_GENERAL) + 1}`;
}
function codigoGrada(lado, n) {
    const fila = Math.floor((n - 1) / POR_FILA_GRADA);
    return `G${lado}-${FILAS_GRADA[fila] || 'X'}${((n - 1) % POR_FILA_GRADA) + 1}`;
}
// Posición (n) a partir del código. Entiende también los códigos de la numeración anterior (GEN-A17, G1-5…).
function indiceGeneral(codigo) {
    const m = /^GEN-([A-Z])(\d+)$/.exec(String(codigo || '').toUpperCase());
    if (!m) return 0;
    const fila = FILAS_GENERAL.indexOf(m[1]), num = parseInt(m[2], 10);
    if (m[1] === 'A' && num > POR_FILA_GENERAL) return num; // código antiguo: GEN-A + posición corrida
    return fila < 0 ? 0 : fila * POR_FILA_GENERAL + num;
}
function indiceGrada(codigo) {
    const c = String(codigo || '').toUpperCase();
    let m = /^G[12]-([A-Z])(\d+)$/.exec(c);
    if (m) { const fila = FILAS_GRADA.indexOf(m[1]); return fila < 0 ? 0 : fila * POR_FILA_GRADA + parseInt(m[2], 10); }
    m = /^G[12]-(\d+)$/.exec(c); // código antiguo: G1-5
    return m ? parseInt(m[1], 10) : 0;
}
// Código de la numeración anterior que corresponde a un código nuevo (o null si no aplica).
function codigoAntiguo(codigo) {
    const c = String(codigo || '').toUpperCase();
    if (/^GEN-[A-G]\d+$/.test(c)) return `GEN-A${indiceGeneral(c)}`;
    const m = /^G([12])-[A-C]\d+$/.exec(c);
    if (m) return `G${m[1]}-${indiceGrada(c)}`;
    return null;
}
// Código nuevo que corresponde a un código de la numeración anterior (o null si ya es nuevo / no aplica).
function codigoNuevoDesdeAntiguo(codigo) {
    const c = String(codigo || '').toUpperCase();
    let m = /^GEN-A(\d+)$/.exec(c);
    if (m) { const n = parseInt(m[1], 10); return n >= 1 && n <= 112 ? codigoGeneral(n) : null; }
    m = /^G([12])-(\d+)$/.exec(c);
    if (m) { const n = parseInt(m[2], 10); return n >= 1 && n <= 12 ? codigoGrada(m[1], n) : null; }
    return null;
}
// ===== Sobreventa =====
// Cuando se agotan los asientos generales se pueden vender entradas "sin asignar". Cada una se guarda como un asiento
// propio (tipoZona 'Sobreventa', código SOBRE-1, SOBRE-2…) para que el escaneo, los informes y la cancelación funcionen igual.
function esSobreventa(codigo) { return /^SOBRE-\d+$/i.test(String(codigo || '')); }
function etiquetaAsiento(codigo, conNumero = false) {
    const m = /^SOBRE-(\d+)$/i.exec(String(codigo || ''));
    if (!m) return codigo;
    return conNumero ? `SIN ASIGNAR #${m[1]}` : 'SIN ASIGNAR';
}
async function validarSobreventaDB(eventoId, asientosReales) {
    const evRes = await db.execute({ sql: "SELECT precioGeneral FROM eventos WHERE id = ?", args: [eventoId] });
    if (!evRes.rows.length) return { error: 'Evento no encontrado.' };
    const r = await db.execute({ sql: "SELECT id, vendido, habilitado FROM asientos WHERE evento_id = ? AND (tipoZona = 'General' OR codigoAsiento LIKE 'GEN-%')", args: [eventoId] });
    if (!r.rows.length) return { error: 'El evento no tiene asientos generales: no se puede vender sobreventa.' };
    const enVenta = new Set(asientosReales.map(a => Number(a.id)));
    const libres = r.rows.filter(a => Number(a.vendido) === 0 && !(a.habilitado !== null && a.habilitado !== undefined && Number(a.habilitado) === 0) && !enVenta.has(Number(a.id)));
    if (libres.length > 0) return { error: `La sobreventa se habilita cuando se agotan los asientos generales. Todavía quedan ${libres.length} disponibles.` };
    return { precio: Number(evRes.rows[0].precioGeneral) || 0 };
}

// Una firma vale si corresponde al código actual del asiento o a su código anterior:
// así siguen funcionando los links y QR que ya se enviaron antes del cambio de numeración.
function firmaValida(sig, ventaId, codigoAsiento) {
    if (typeof sig !== 'string') return false;
    const candidatos = [codigoAsiento, codigoAntiguo(codigoAsiento)].filter(Boolean);
    return candidatos.some(c => {
        const esperada = generarFirma(ventaId, c);
        return sig.length === esperada.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperada));
    });
}

function verificarFirmaMiddleware(req, res, next) {
    const { id } = req.params;
    const { sig } = req.query;

    if (!sig) return res.status(403).json({ exito: false, mensaje: 'Firma de seguridad requerida' });

    const verificar = (codigoAsiento) => {
        if (firmaValida(sig, id, codigoAsiento)) return next();
        return res.status(401).json({ exito: false, mensaje: 'Entrada inválida o firma alterada' });
    };

    if (db) {
        db.execute({ sql: "SELECT codigoAsiento FROM ventas WHERE id = ?", args: [id] })
            .then(resV => {
                if (resV.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });
                verificar(resV.rows[0].codigoAsiento);
            })
            .catch(err => res.status(500).json({ exito: false, mensaje: 'Error al verificar firma' }));
    } else {
        const venta = ventasMemoria.find(v => v.id == id);
        if (!venta) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });
        verificar(venta.codigoAsiento);
    }
}

// Conexión a DB Turso
let db = null;
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    db = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    });
    console.log(' Conectado exitosamente a la base de datos de Turso.');
} else {
    console.warn('⚠️ No se encontraron las credenciales de Turso. Usando almacenamiento temporal en memoria.');
}

// Usuarios de la primera puesta en marcha. La clave sale de INITIAL_ADMIN_PASSWORD; si no
// está definida se genera una al azar y se muestra una sola vez en la consola del servidor.
async function usuariosIniciales() {
    let claveAdmin = process.env.INITIAL_ADMIN_PASSWORD;
    const generada = !claveAdmin;
    if (generada) claveAdmin = crypto.randomBytes(9).toString('base64url');
    const claveOperario = crypto.randomBytes(9).toString('base64url');
    if (generada) {
        console.warn('==============================================================');
        console.warn(` Usuario inicial: admin   Clave: ${claveAdmin}`);
        console.warn(` Usuario inicial: operario1   Clave: ${claveOperario}`);
        console.warn(' Guardalas ahora: no se vuelven a mostrar. Cambialas desde el panel.');
        console.warn('==============================================================');
    } else {
        console.warn(` Usuario inicial admin creado con INITIAL_ADMIN_PASSWORD. operario1 recibió una clave aleatoria: ${claveOperario}`);
    }
    return [
        { usuario: 'admin', clave: await hashClave(claveAdmin), tipo: 'super', identificacion: 'SUP-01' },
        { usuario: 'operario1', clave: await hashClave(claveOperario), tipo: 'vendedor', identificacion: 'VEN-01' }
    ];
}

async function advertirClavesDebiles() {
    try {
        const lista = db ? (await db.execute("SELECT usuario, clave FROM usuarios")).rows : usuariosMemoria;
        for (const u of lista) {
            if (await verificarClave('1234', u.clave)) {
                console.warn(`⚠️  El usuario "${u.usuario}" todavía usa la clave "1234". Cambiala desde Superusuario → Restablecer clave.`);
            }
        }
    } catch (e) { /* solo informativo */ }
}

async function inicializarTablasDB() {
    if (!db) return;
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario TEXT UNIQUE,
                clave TEXT,
                tipo TEXT,
                identificacion TEXT
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS eventos (
                id TEXT PRIMARY KEY,
                nombre TEXT,
                fecha TEXT,
                hora TEXT,
                precioGeneral REAL,
                dispGen INTEGER,
                precioGradas REAL,
                dispGrada INTEGER
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS cupones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id TEXT,
                codigo TEXT,
                porcentaje REAL DEFAULT 0,
                monto_fijo REAL DEFAULT 0,
                fecha_creacion TEXT
            );
        `);
        try {
                await db.execute("ALTER TABLE cupones ADD COLUMN fecha_creacion TEXT");
            } catch (e) {
                // Si la columna ya existe, se ignora el error de forma segura
            }
        await db.execute(`
            CREATE TABLE IF NOT EXISTS asientos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id TEXT,
                codigoAsiento TEXT,
                tipoZona TEXT,
                precio REAL,
                vendido INTEGER DEFAULT 0,
                habilitado INTEGER DEFAULT 1,
                asistio INTEGER DEFAULT 0,
                cupon_codigo TEXT
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS ventas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id TEXT,
                asiento_id INTEGER,
                codigoAsiento TEXT,
                nombre TEXT,
                apellido TEXT,
                contacto TEXT,
                email TEXT,
                metodo_pago TEXT,
                monto_total REAL,
                vendedor TEXT,
                fechaCompra TEXT,
                cupon_codigo TEXT
            );
        `);
        // Bases creadas antes de existir esta columna: se agrega si falta.
        try { await db.execute("ALTER TABLE ventas ADD COLUMN cupon_codigo TEXT"); } catch (e) { /* ya existe */ }
        // Identifica las entradas que se vendieron juntas en una misma compra.
        try { await db.execute("ALTER TABLE ventas ADD COLUMN grupo_venta TEXT"); } catch (e) { /* ya existe */ }

        // Pasa los asientos creados con la numeración anterior (GEN-A17, G1-5…) a la nueva por filas (GEN-B1, G1-B1…).
        // Es idempotente: los que ya están con la numeración nueva no se tocan. Las entradas ya vendidas siguen siendo
        // válidas porque la verificación de firma también acepta el código anterior.
        try {
            const viejos = await db.execute("SELECT id, codigoAsiento FROM asientos WHERE codigoAsiento LIKE 'GEN-%' OR codigoAsiento LIKE 'G1-%' OR codigoAsiento LIKE 'G2-%'");
            let renombrados = 0;
            for (const row of viejos.rows) {
                const nuevo = codigoNuevoDesdeAntiguo(row.codigoAsiento);
                if (!nuevo || nuevo === String(row.codigoAsiento).toUpperCase()) continue;
                await db.execute({ sql: "UPDATE asientos SET codigoAsiento = ? WHERE id = ?", args: [nuevo, row.id] });
                await db.execute({ sql: "UPDATE ventas SET codigoAsiento = ? WHERE asiento_id = ? AND codigoAsiento = ?", args: [nuevo, row.id, row.codigoAsiento] });
                renombrados++;
            }
            if (renombrados) console.log(` Numeración de asientos actualizada: ${renombrados} asientos renombrados.`);
        } catch (e) {
            console.error('No se pudo actualizar la numeración de asientos:', e);
        }

        const resUser = await db.execute("SELECT COUNT(*) as cant FROM usuarios");
        if (Number(resUser.rows[0].cant) === 0) {
            const iniciales = await usuariosIniciales();
            for (const u of iniciales) {
                await db.execute({
                    sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                    args: [u.usuario, u.clave, u.tipo, u.identificacion]
                });
            }
        }
        await advertirClavesDebiles();
        console.log(' Tablas creadas/verificadas en Turso.');
    } catch (e) {
        console.error('Error al inicializar las tablas de Turso:', e);
    }
}

inicializarTablasDB();
if (!db) {
    usuariosIniciales().then(l => {
        usuariosMemoria = l.map((u, i) => ({ id: i + 1, ...u }));
    }).catch(e => console.error(e));
}

// Memoria Temporal
let usuariosMemoria = [];
let eventosMemoria = [];
let cuponesMemoria = [{ codigo: 'DESCUENTO10', porcentaje: 10, monto_fijo: 0 }];
let asientosMemoria = {};
let ventasMemoria = [];
let configMemoria = {};

async function generarAsientosParaEvento(eventoObj) {
    const pGen = Number(eventoObj.precioGeneral) || 1500;
    const pGrada = Number(eventoObj.precioGradas) || 3000;
    const totalGen = Math.min(Math.max(Number(eventoObj.dispGen) || 0, 0), 112);
    const totalGrada = Math.min(Math.max(Number(eventoObj.dispGrada) || 0, 0), 24);

    if (db) {
        for (let i = 1; i <= totalGen; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, codigoGeneral(i), 'General', pGen]
            });
        }
        const porG1 = Math.ceil(totalGrada / 2);
        const porG2 = totalGrada - porG1;

        for (let i = 1; i <= porG1; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, codigoGrada(1, i), 'Grada', pGrada]
            });
        }
        for (let i = 1; i <= porG2; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, codigoGrada(2, i), 'Grada', pGrada]
            });
        }
    } else {
        let lista = [];
        let idCounter = 1;

        for (let i = 1; i <= totalGen; i++) {
            lista.push({ id: idCounter++, codigoAsiento: codigoGeneral(i), tipoZona: 'General', precio: pGen, vendido: 0, habilitado: 1, asistio: 0 });
        }
        const porG1 = Math.ceil(totalGrada / 2);
        const porG2 = totalGrada - porG1;
        for (let i = 1; i <= porG1; i++) {
            lista.push({ id: idCounter++, codigoAsiento: codigoGrada(1, i), tipoZona: 'Grada', precio: pGrada, vendido: 0, habilitado: 1, asistio: 0 });
        }
        for (let i = 1; i <= porG2; i++) {
            lista.push({ id: idCounter++, codigoAsiento: codigoGrada(2, i), tipoZona: 'Grada', precio: pGrada, vendido: 0, habilitado: 1, asistio: 0 });
        }
        asientosMemoria[eventoObj.id] = lista;
    }
}

// Endpoints Auth & Eventos
// Aviso general (p. ej. mantenimiento). Se configura con variables de entorno, sin tocar el código:
// AVISO_TEXTO = mensaje a mostrar; AVISO_HASTA = fecha/hora ISO a partir de la cual deja de mostrarse (opcional).
app.get('/api/aviso', (req, res) => {
    const texto = String(process.env.AVISO_TEXTO || '').trim().slice(0, 500);
    const hasta = process.env.AVISO_HASTA ? new Date(process.env.AVISO_HASTA) : null;
    const vigente = texto && !(hasta && !isNaN(hasta) && Date.now() > hasta.getTime());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ exito: true, texto: vigente ? texto : '' });
});

app.post('/api/login', async (req, res) => {
    const { usuario, clave } = req.body || {};
    const limite = `${req.ip}|${String(usuario || '').toLowerCase()}`;
    if (loginBloqueado(limite)) {
        return res.status(429).json({ exito: false, mensaje: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' });
    }
    try {
        let u = null;
        if (db) {
            const result = await db.execute({
                sql: "SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER(?)",
                args: [String(usuario || '')]
            });
            if (result.rows.length > 0) u = result.rows[0];
        } else {
            u = usuariosMemoria.find(x => x.usuario.toLowerCase() === String(usuario || '').toLowerCase()) || null;
        }

        if (u && await verificarClave(String(clave || ''), u.clave)) {
            intentosLogin.delete(limite);
            // Migración transparente: si la clave estaba en texto plano, se guarda hasheada.
            if (!esClaveHasheada(u.clave)) {
                const nueva = await hashClave(clave);
                if (db) await db.execute({ sql: "UPDATE usuarios SET clave = ? WHERE id = ?", args: [nueva, u.id] });
                else u.clave = nueva;
            }
            const token = crearToken(u);
            return res.json({ exito: true, usuario: u.usuario, tipo: u.tipo, id: u.id, token });
        }
        // Si el usuario no existe se hace el mismo trabajo para no delatarlo por tiempo de respuesta.
        if (!u) await verificarClave(String(clave || ''), 'scrypt$00$00');
    } catch (e) { console.error(e); }
    registrarFallo(limite);
    res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
});

app.get('/api/eventos/:eventoId/historial', async (req, res) => {
    const { eventoId } = req.params;
    const esTodos = !eventoId || eventoId.toUpperCase() === 'TODOS';

    try {
        let ventas = [];
        let asistentes = 0;

        if (db) {
            const sqlVentas = esTodos ? "SELECT * FROM ventas" : "SELECT * FROM ventas WHERE evento_id = ?";
            const sqlAsientos = esTodos ? "SELECT * FROM asientos" : "SELECT * FROM asientos WHERE evento_id = ?";
            const args = esTodos ? [] : [eventoId];

            const vRes = await db.execute({ sql: sqlVentas, args });
            const aRes = await db.execute({ sql: sqlAsientos, args });

            ventas = vRes.rows || [];
            asistentes = (aRes.rows || []).filter(a => Number(a.vendido) === 1 && Number(a.asistio) === 1).length;
        } else {
            const todasVentas = typeof ventasMemoria !== 'undefined' ? ventasMemoria : [];
            ventas = esTodos ? todasVentas : todasVentas.filter(v => v.evento_id === eventoId);

            if (esTodos) {
                const todosAsientos = Object.values(typeof asientosMemoria !== 'undefined' ? asientosMemoria : {}).flat();
                asistentes = todosAsientos.filter(a => Number(a.vendido) === 1 && Number(a.asistio) === 1).length;
            } else {
                const listaA = (typeof asientosMemoria !== 'undefined' && asientosMemoria[eventoId]) || [];
                asistentes = listaA.filter(a => Number(a.vendido) === 1 && Number(a.asistio) === 1).length;
            }
        }

        const recaudado = ventas.reduce((acc, curr) => acc + Number(curr.monto_total || curr.monto || 0), 0);

        return res.json({
            nombre: esTodos ? "Todos los Eventos" : `Evento ${eventoId}`,
            recaudado,
            totalVentas: ventas.length,
            asistencia: asistentes,
            historialVentas: ventas.map(v => ({
                idReserva: v.id || v.idReserva || '-',
                eventoId: v.evento_id || eventoId,
                fecha: v.fechaCompra || v.fecha || null,
                cliente: v.nombre ? `${v.nombre} ${v.apellido || ''}`.trim() : (v.cliente || '-'),
                email: v.email || '-',
                asiento: etiquetaAsiento(v.codigoAsiento || v.asiento || '-', true),
                metodoPago: v.metodo_pago || v.metodoPago || '-',
                monto: v.monto_total || v.monto || 0,
                estado: 'Completado'
            }))
        });
    } catch (e) {
        console.error("Error en /historial:", e);
        return res.status(500).json({ exito: false, mensaje: 'Error al obtener historial' });
    }
});

app.get('/api/eventos/:eventoId/descargar-excel', async (req, res) => {
    const { eventoId } = req.params;
    try {
        let ventas = [];
        if (db) {
            const vRes = await db.execute({ sql: "SELECT * FROM ventas WHERE evento_id = ?", args: [eventoId] });
            ventas = vRes.rows || [];
        } else {
            ventas = (typeof ventasMemoria !== 'undefined' ? ventasMemoria : []).filter(v => v.evento_id === eventoId);
        }

        let csv = "\uFEFFID Reserva;Fecha;Cliente;Email;Asiento;Metodo Pago;Monto\n";
        ventas.forEach(v => {
            const cliente = v.nombre ? `${v.nombre} ${v.apellido || ''}` : (v.cliente || '-');
            csv += `${v.id || v.idReserva || '-'};${v.fechaCompra || v.fecha || '-'};${cliente};${v.email || '-'};${etiquetaAsiento(v.codigoAsiento || v.asiento || '-', true)};${v.metodo_pago || v.metodoPago || '-'};${v.monto_total || v.monto || 0}\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_${eventoId}.csv"`);
        return res.status(200).send(csv);
    } catch (e) {
        console.error("Error en descarga Excel:", e);
        return res.status(500).send("Error generando el archivo Excel.");
    }
});

app.get('/api/eventos', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT * FROM eventos");
            return res.json(result.rows);
        } catch (e) { console.error(e); }
    }
    res.json(eventosMemoria);
});

app.post('/api/eventos/crear', async (req, res) => {
    const evento = req.body;
    const dGen = Number(evento.dispGen) || 0;
    const dGrada = Number(evento.dispGrada) || 0;

    if (dGen < 0 || dGen > 112) {
        return res.status(400).json({ exito: false, mensaje: 'La cantidad de asientos en General no puede superar el aforo máximo de 112.' });
    }
    if (dGrada < 0 || dGrada > 24) {
        return res.status(400).json({ exito: false, mensaje: 'La cantidad de asientos en Gradas no puede superar el aforo máximo de 24.' });
    }

    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO eventos (id, nombre, fecha, hora, precioGeneral, dispGen, precioGradas, dispGrada) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                args: [evento.id, evento.nombre, evento.fecha, evento.hora, evento.precioGeneral, dGen, evento.precioGradas, dGrada]
            });
            await generarAsientosParaEvento({ ...evento, dispGen: dGen, dispGrada: dGrada });
            return res.json({ exito: true, mensaje: 'Evento creado con éxito' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al crear evento' });
        }
    } else {
        eventosMemoria.push({ ...evento, dispGen: dGen, dispGrada: dGrada });
        await generarAsientosParaEvento({ ...evento, dispGen: dGen, dispGrada: dGrada });
        return res.json({ exito: true, mensaje: 'Evento creado (Memoria)' });
    }
});

app.post('/api/config/email-informe', (req, res) => {
    const { email } = req.body;
    configMemoria.emailInforme = email;
    res.json({ exito: true, mensaje: 'Email de informes guardado correctamente' });
});

app.post('/api/cupones/crear', async (req, res) => {
    try {
        const { evento_id, codigo, porcentaje, monto_fijo } = req.body;
        if (!evento_id || !codigo) return res.status(400).json({ exito: false, mensaje: 'El evento y el código son obligatorios.' });

        const pct = parseFloat(porcentaje) || 0;
        const monto = parseFloat(monto_fijo) || 0;
        const fechaCreacion = new Date().toISOString();

        if (pct > 0 && monto > 0) return res.status(400).json({ exito: false, mensaje: 'No puedes aplicar Porcentaje y Monto Fijo simultáneamente.' });
        if (pct === 0 && monto === 0) return res.status(400).json({ exito: false, mensaje: 'El cupón debe tener un valor mayor a 0.' });

        if (db) {
            await db.execute({
                sql: 'INSERT INTO cupones (evento_id, codigo, porcentaje, monto_fijo, fecha_creacion) VALUES (?, ?, ?, ?, ?)',
                args: [evento_id, codigo.toUpperCase(), pct, monto, fechaCreacion]
            });
            return res.json({ exito: true, mensaje: 'Cupón creado con éxito' });
        } else {
            cuponesMemoria.push({ 
                id: cuponesMemoria.length + 1,
                evento_id, 
                codigo: codigo.toUpperCase(), 
                porcentaje: pct, 
                monto_fijo: monto,
                fecha_creacion: fechaCreacion 
            });
            return res.json({ exito: true, mensaje: 'Cupón guardado (Memoria)' });
        }
    } catch (error) {
        res.status(500).json({ exito: false, mensaje: 'Error al guardar cupón: ' + error.message });
    }
});

app.delete('/api/cupones/eliminar/:id', async (req, res) => {
    const { id } = req.params;
    const rol = (req.body?.rol || req.query?.rol || '').toLowerCase();
    const esAdminOSuper = ['super', 'admin', 'adm', 'administrador'].includes(rol);

    if (db) {
        try {
            const cRes = await db.execute({ sql: "SELECT * FROM cupones WHERE id = ?", args: [id] });
            if (cRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Cupón no encontrado.' });

            const cupon = cRes.rows[0];

                if (cupon.fecha_creacion) {
                const minutosTranscurridos = (new Date() - new Date(cupon.fecha_creacion)) / (1000 * 60);
                if (minutosTranscurridos > 15) {
                    return res.status(403).json({ 
                        exito: false, 
                        mensaje: 'Límite expirado: Han transcurrido más de 15 minutos desde la creación del cupón.' 
                    });
                }
            }

            await db.execute({ sql: "DELETE FROM cupones WHERE id = ?", args: [id] });
            return res.json({ exito: true, mensaje: 'Cupón eliminado correctamente' });
        } catch (e) {
            console.error("Error al eliminar cupón:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al eliminar el cupón' });
        }
    } else {
        const index = cuponesMemoria.findIndex(c => c.id == id);
        if (index === -1) return res.status(404).json({ exito: false, mensaje: 'Cupón no encontrado.' });

        const cupon = cuponesMemoria[index];
        if (cupon.fecha_creacion) {
            const minutosTranscurridos = (new Date() - new Date(cupon.fecha_creacion)) / (1000 * 60);
            if (minutosTranscurridos > 15 && !esAdminOSuper) {
                return res.status(403).json({ 
                    exito: false, 
                    mensaje: 'Límite expirado: Han transcurrido más de 15 minutos desde la creación del cupón.' 
                });
            }
        }

        cuponesMemoria.splice(index, 1);
        return res.json({ exito: true, mensaje: 'Cupón eliminado (Memoria)' });
    }
});

app.get('/api/eventos/:id/asientos', async (req, res) => {
    const { id } = req.params;
    if (db) {
        try {
            const result = await db.execute({ 
                sql: `SELECT a.*, v.cupon_codigo 
                      FROM asientos a 
                      LEFT JOIN ventas v ON a.id = v.asiento_id 
                      WHERE a.evento_id = ?`, 
                args: [id] 
            });
            return res.json(result.rows);
        } catch (e) { 
            console.error(e); 
            return res.status(500).json({ exito: false, mensaje: 'Error al obtener asientos' });
        }
    }
    
    // Modo Memoria Temporal
    if (!asientosMemoria[id]) asientosMemoria[id] = [];
    const listaConCupon = asientosMemoria[id].map(a => {
        const venta = ventasMemoria.find(v => v.asiento_id === a.id);
        return { ...a, cupon_codigo: venta ? venta.cupon_codigo : null };
    });
    res.json(listaConCupon);
});
app.get('/api/cupones/evento/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    if (db) {
        try {
            const result = await db.execute({ sql: "SELECT * FROM cupones WHERE evento_id = ?", args: [eventoId] });
            return res.json(result.rows);
        } catch (e) { return res.status(500).json({ exito: false, mensaje: 'Error al obtener cupones' }); }
    } else {
        res.json(cuponesMemoria.filter(c => c.evento_id === eventoId));
    }
});

app.get('/api/cupones', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT * FROM cupones");
            return res.json(result.rows);
        } catch (e) { console.error(e); }
    }
    res.json(cuponesMemoria);
});

// Reparto del descuento de un cupón sobre el TOTAL de la compra.
// El descuento (porcentaje del total, o monto fijo) se descuenta primero de la ÚLTIMA entrada elegida y, si todavía
// sobra, de la anterior, y así hacia atrás. Ejemplo 2x1 (cupón de 50 %) con 2 entradas iguales:
// la entrada 1 se cobra completa y la entrada 2 queda con 100 % de descuento.
// Se trabaja en centavos para no arrastrar errores de redondeo. Devuelve el monto a cobrar de cada entrada.
const MAX_ASIENTOS_POR_VENTA = 10;
// Cupones de "2 entradas": el código 2X1 y los DESCUENTO + número (DESCUENTO1 … DESCUENTO100).
// Solo valen para una compra de exactamente 2 entradas y el descuento recae sobre la 2.ª. Los demás cupones no tienen esta restricción.
const ENTRADAS_CUPON_DE_2 = 2;
const MSG_CUPON_MAX = `Este cupón solo se puede aplicar para ${ENTRADAS_CUPON_DE_2} entradas, no más.`;
const MSG_CUPON_MIN = `Este cupón requiere comprar exactamente ${ENTRADAS_CUPON_DE_2} entradas.`;
function esCuponDe2(codigo) {
    const c = String(codigo || '').trim().toUpperCase();
    return c === '2X1' || /^DESCUENTO\d+$/.test(c);
}
function errorCuponDe2(cupon, cantidad) {
    if (!cupon || !esCuponDe2(cupon.codigo)) return null;
    if (cantidad > ENTRADAS_CUPON_DE_2) return MSG_CUPON_MAX;
    if (cantidad < ENTRADAS_CUPON_DE_2) return MSG_CUPON_MIN;
    return null;
}
function repartirDescuento(precios, cupon) {
    const c = precios.map(p => Math.round((Number(p) || 0) * 100));
    const totalC = c.reduce((s, x) => s + x, 0);
    // 2X1 / DESCUENTOXXX: el descuento recae solo sobre la 2.ª entrada (2X1 = la 2.ª gratis).
    if (cupon && esCuponDe2(cupon.codigo)) {
        const cobrar2 = c.slice();
        if (c.length === ENTRADAS_CUPON_DE_2) {
            let d = 0;
            if (String(cupon.codigo).trim().toUpperCase() === '2X1') d = c[1];
            else if (Number(cupon.porcentaje) > 0) d = Math.round(c[1] * Math.min(Number(cupon.porcentaje), 100) / 100);
            else if (Number(cupon.monto_fijo) > 0) d = Math.round(Number(cupon.monto_fijo) * 100);
            cobrar2[1] -= Math.min(d, c[1]);
        }
        return cobrar2.map(x => x / 100);
    }
    let desc = 0;
    if (cupon) {
        const pct = Number(cupon.porcentaje) || 0;
        const fijo = Number(cupon.monto_fijo) || 0;
        if (pct > 0) desc = Math.round(totalC * Math.min(pct, 100) / 100);
        else if (fijo > 0) desc = Math.round(fijo * 100);
    }
    desc = Math.min(desc, totalC);
    const cobrar = c.slice();
    for (let i = cobrar.length - 1; i >= 0 && desc > 0; i--) {
        const d = Math.min(desc, cobrar[i]);
        cobrar[i] -= d; desc -= d;
    }
    return cobrar.map(x => x / 100);
}
// El texto guardado de la venta es el de la lista desplegable: "CODIGO (10% OFF)" o "CODIGO ($500 OFF)".
async function buscarCuponDeVenta(eventoId, texto) {
    const t = String(texto || '').trim();
    if (!t) return { cupon: null, valido: true };
    const lista = db
        ? (await db.execute({ sql: "SELECT * FROM cupones WHERE evento_id = ?", args: [eventoId] })).rows
        : cuponesMemoria.filter(c => c.evento_id === eventoId);
    const etiqueta = (c) => `${c.codigo} (${Number(c.porcentaje) > 0 ? `${c.porcentaje}% OFF` : `$${c.monto_fijo} OFF`})`;
    const cupon = lista.find(c => etiqueta(c) === t) || lista.find(c => t.toUpperCase().startsWith(String(c.codigo).toUpperCase() + ' ('));
    return { cupon: cupon || null, valido: !!cupon };
}
function montoCoincide(enviado, esperado) {
    const n = Number(enviado);
    return Number.isFinite(n) && Math.abs(n - esperado) <= 0.01;
}

app.post('/api/ventas/procesar', async (req, res) => {
    const venta = req.body || {};
    const vendedorNombre = venta.usuario_vendedor || venta.vendedor || 'Sistema';
    const cuponCodigo = String(venta.cupon_codigo || '');

    const validarTiempoVenta = (fechaStr, horaStr) => {
        if (!fechaStr || !horaStr) return true;
        const inicioEvento = new Date(`${fechaStr}T${horaStr}:00`);
        const limiteVenta = new Date(inicioEvento.getTime() + (5 * 60 * 60 * 1000));
        return new Date() <= limiteVenta;
    };

    // Uno o varios asientos. El orden en que llegan es el orden de selección: el último recibe el descuento primero.
    let ids = Array.isArray(venta.asientos_ids) ? venta.asientos_ids : (venta.asiento_id != null ? [venta.asiento_id] : []);
    ids = ids.map(Number);
    const sobreCant = Number(venta.sobreventa_cantidad) || 0;
    if (!Number.isInteger(sobreCant) || sobreCant < 0) return res.status(400).json({ exito: false, mensaje: 'Cantidad de sobreventa inválida.' });
    if ((!ids.length && !sobreCant) || ids.some(n => !Number.isInteger(n))) return res.status(400).json({ exito: false, mensaje: 'Seleccioná al menos un asiento.' });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ exito: false, mensaje: 'Hay asientos repetidos en la selección.' });
    if (ids.length + sobreCant > MAX_ASIENTOS_POR_VENTA) return res.status(400).json({ exito: false, mensaje: `Se pueden vender hasta ${MAX_ASIENTOS_POR_VENTA} entradas por compra.` });

    const grupo = crypto.randomBytes(6).toString('hex');
    const respuestaOk = (items, total) => ({
        exito: true,
        mensaje: items.length > 1 ? `Venta registrada: ${items.length} entradas` : 'Venta registrada',
        ventaId: items[0].ventaId, sig: items[0].sig, // compatibilidad con la venta de un solo asiento
        ventas: items, total
    });

    if (db) {
        try {
            const evRes = await db.execute({ sql: "SELECT fecha, hora FROM eventos WHERE id = ?", args: [venta.evento_id] });
            if (evRes.rows.length > 0) {
                const { fecha, hora } = evRes.rows[0];
                if (!validarTiempoVenta(fecha, hora)) {
                    return res.status(403).json({ exito: false, mensaje: 'La venta para este evento ha finalizado (pasaron más de 5hs del inicio).' });
                }
            }

            const asientos = [];
            for (const id of ids) {
                const r = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ? AND evento_id = ?", args: [id, venta.evento_id] });
                if (r.rows.length === 0) return res.json({ exito: false, mensaje: 'Asiento no encontrado' });
                const a = r.rows[0];
                if (Number(a.vendido) === 1) return res.json({ exito: false, mensaje: `Asiento ocupado (${a.codigoAsiento})` });
                if (a.habilitado !== undefined && a.habilitado !== null && Number(a.habilitado) === 0) return res.json({ exito: false, mensaje: `Asiento no disponible (${a.codigoAsiento})` });
                asientos.push(a);
            }

            // Sobreventa: solo cuando ya no quedan asientos generales disponibles. Se crean más abajo, justo antes de reservarlos.
            if (sobreCant > 0) {
                const chk = await validarSobreventaDB(venta.evento_id, asientos);
                if (chk.error) return res.status(400).json({ exito: false, mensaje: chk.error });
                for (let k = 0; k < sobreCant; k++) asientos.push({ id: null, codigoAsiento: null, tipoZona: 'Sobreventa', precio: chk.precio, _sobre: true });
            }

            const bc = await buscarCuponDeVenta(venta.evento_id, cuponCodigo);
            if (!bc.valido) return res.status(400).json({ exito: false, mensaje: 'El cupón seleccionado ya no es válido para este evento.' });
            const errCupon = errorCuponDe2(bc.cupon, asientos.length);
            if (errCupon) return res.status(400).json({ exito: false, mensaje: errCupon });
            const montos = repartirDescuento(asientos.map(a => a.precio), bc.cupon);
            const totalEsperado = montos.reduce((s, x) => s + x, 0);
            if (!montoCoincide(venta.monto_total, totalEsperado)) {
                return res.status(400).json({ exito: false, mensaje: 'El monto no coincide con el precio y el cupón vigentes. Recargá el evento e intentá de nuevo.' });
            }
            // El cupón queda registrado solo en las entradas que realmente reciben descuento.
            const cuponDe = asientos.map((a, i) => (Number(a.precio) - montos[i] > 0.004 ? cuponCodigo : ''));

            // Alta de los asientos de sobreventa (SOBRE-n). Si algo falla después, se borran los que quedaron sin vender.
            const sobreCreados = [];
            const limpiarSobre = async () => { for (const sid of sobreCreados) { try { await db.execute({ sql: "DELETE FROM asientos WHERE id = ? AND vendido = 0", args: [sid] }); } catch (e) {} } };
            if (asientos.some(a => a._sobre)) {
                try {
                    let maxN = 0;
                    const rs = await db.execute({ sql: "SELECT codigoAsiento FROM asientos WHERE evento_id = ? AND codigoAsiento LIKE 'SOBRE-%'", args: [venta.evento_id] });
                    rs.rows.forEach(r => { const m = /^SOBRE-(\d+)$/.exec(String(r.codigoAsiento)); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); });
                    for (const a of asientos) {
                        if (!a._sobre) continue;
                        maxN++;
                        const ins = await db.execute({
                            sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, 'Sobreventa', ?, 0, 1, 0) RETURNING id",
                            args: [venta.evento_id, `SOBRE-${maxN}`, a.precio]
                        });
                        a.id = ins.rows[0].id; a.codigoAsiento = `SOBRE-${maxN}`; a.vendido = 0;
                        sobreCreados.push(a.id);
                    }
                } catch (eSobre) { await limpiarSobre(); throw eSobre; }
            }

            // Reserva atómica de cada asiento; si alguno falla se liberan los ya reservados.
            const reservados = [];
            const liberar = async (lista) => { for (const id of lista) await db.execute({ sql: "UPDATE asientos SET vendido = 0, cupon_codigo = NULL WHERE id = ?", args: [id] }); };
            for (let i = 0; i < asientos.length; i++) {
                const reserva = await db.execute({ sql: "UPDATE asientos SET vendido = 1, cupon_codigo = ? WHERE id = ? AND vendido = 0", args: [cuponDe[i], asientos[i].id] });
                if (!reserva.rowsAffected) {
                    await liberar(reservados);
                    await limpiarSobre();
                    return res.json({ exito: false, mensaje: `Asiento ocupado (${etiquetaAsiento(asientos[i].codigoAsiento, true)}). No se registró ninguna entrada.` });
                }
                reservados.push(asientos[i].id);
            }

            const items = []; const idsVenta = [];
            try {
                const ahora = new Date().toISOString();
                for (let i = 0; i < asientos.length; i++) {
                    const insRes = await db.execute({
                        sql: `INSERT INTO ventas (evento_id, asiento_id, codigoAsiento, nombre, apellido, contacto, email, metodo_pago, monto_total, vendedor, fechaCompra, cupon_codigo, grupo_venta)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                        args: [venta.evento_id, asientos[i].id, asientos[i].codigoAsiento, venta.nombre, venta.apellido, venta.contacto, venta.email || '', venta.metodo_pago, montos[i], vendedorNombre, ahora, cuponDe[i], grupo]
                    });
                    const vid = insRes.rows[0].id; idsVenta.push(vid);
                    items.push({ ventaId: vid, sig: generarFirma(vid, asientos[i].codigoAsiento), asiento_id: asientos[i].id, codigoAsiento: asientos[i].codigoAsiento, precio: Number(asientos[i].precio), monto: montos[i], cupon_codigo: cuponDe[i] });
                }
            } catch (errIns) {
                // Si no se pudo registrar alguna venta, no queda nada a medias: se borran las creadas y se liberan los asientos.
                for (const vid of idsVenta) { try { await db.execute({ sql: "DELETE FROM ventas WHERE id = ?", args: [vid] }); } catch (e) {} }
                await liberar(reservados);
                await limpiarSobre();
                throw errIns;
            }
            return res.json(respuestaOk(items, totalEsperado));
        } catch (e) {
            console.error("Error al procesar venta:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al procesar la venta' });
        }
    } else {
        const evento = eventosMemoria.find(e => e.id === venta.evento_id);
        if (evento && !validarTiempoVenta(evento.fecha, evento.hora)) {
            return res.status(403).json({ exito: false, mensaje: 'La venta para este evento ha finalizado (pasaron más de 5hs del inicio).' });
        }

        const lista = asientosMemoria[venta.evento_id] || [];
        const asientos = [];
        for (const id of ids) {
            const a = lista.find(x => Number(x.id) === id);
            if (!a || a.vendido === 1) return res.json({ exito: false, mensaje: 'Asiento no disponible' });
            if (a.habilitado === 0) return res.json({ exito: false, mensaje: `Asiento no disponible (${a.codigoAsiento})` });
            asientos.push(a);
        }
        if (sobreCant > 0) {
            const evMem = eventosMemoria.find(e => e.id === venta.evento_id);
            if (!evMem) return res.status(400).json({ exito: false, mensaje: 'Evento no encontrado.' });
            const generales = lista.filter(a => a.tipoZona === 'General' || String(a.codigoAsiento).startsWith('GEN-'));
            if (!generales.length) return res.status(400).json({ exito: false, mensaje: 'El evento no tiene asientos generales: no se puede vender sobreventa.' });
            const enVenta = new Set(asientos.map(a => a.id));
            const libres = generales.filter(a => a.vendido !== 1 && a.habilitado !== 0 && !enVenta.has(a.id));
            if (libres.length) return res.status(400).json({ exito: false, mensaje: `La sobreventa se habilita cuando se agotan los asientos generales. Todavía quedan ${libres.length} disponibles.` });
            if (!asientosMemoria[venta.evento_id]) asientosMemoria[venta.evento_id] = lista;
            // Se crean recién cuando la venta ya está validada (más abajo); acá solo se reservan en el cálculo del monto.
            for (let k = 0; k < sobreCant; k++) asientos.push({ id: null, codigoAsiento: null, tipoZona: 'Sobreventa', precio: Number(evMem.precioGeneral) || 0, _sobre: true });
        }
        const bcMem = await buscarCuponDeVenta(venta.evento_id, cuponCodigo);
        if (!bcMem.valido) return res.status(400).json({ exito: false, mensaje: 'El cupón seleccionado ya no es válido para este evento.' });
        const errCuponMem = errorCuponDe2(bcMem.cupon, asientos.length);
        if (errCuponMem) return res.status(400).json({ exito: false, mensaje: errCuponMem });
        const montos = repartirDescuento(asientos.map(a => a.precio), bcMem.cupon);
        const totalEsperado = montos.reduce((s, x) => s + x, 0);
        if (!montoCoincide(venta.monto_total, totalEsperado)) {
            return res.status(400).json({ exito: false, mensaje: 'El monto no coincide con el precio y el cupón vigentes. Recargá el evento e intentá de nuevo.' });
        }

        if (asientos.some(a => a._sobre)) {
            let maxN = 0, maxId = lista.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
            lista.forEach(x => { const m = /^SOBRE-(\d+)$/.exec(String(x.codigoAsiento)); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); });
            asientos.forEach((a, i) => {
                if (!a._sobre) return;
                const nuevoAs = { id: ++maxId, codigoAsiento: `SOBRE-${++maxN}`, tipoZona: 'Sobreventa', precio: a.precio, vendido: 0, habilitado: 1, asistio: 0 };
                lista.push(nuevoAs); asientos[i] = nuevoAs;
            });
        }
        const items = [];
        const ahora = new Date().toISOString();
        asientos.forEach((a, i) => {
            const cup = Number(a.precio) - montos[i] > 0.004 ? cuponCodigo : '';
            a.vendido = 1;
            const nuevaVentaId = ventasMemoria.reduce((m, v) => Math.max(m, Number(v.id) || 0), 0) + 1;
            const { asientos_ids, ...base } = venta;
            ventasMemoria.push({ ...base, asiento_id: a.id, id: nuevaVentaId, codigoAsiento: a.codigoAsiento, monto_total: montos[i], vendedor: vendedorNombre, fechaCompra: ahora, cupon_codigo: cup, grupo_venta: grupo });
            items.push({ ventaId: nuevaVentaId, sig: generarFirma(nuevaVentaId, a.codigoAsiento), asiento_id: a.id, codigoAsiento: a.codigoAsiento, precio: Number(a.precio), monto: montos[i], cupon_codigo: cup });
        });
        const r = respuestaOk(items, totalEsperado);
        r.mensaje += ' (Memoria)';
        res.json(r);
    }
});

app.delete('/api/ventas/cancelar/:id', async (req, res) => {
    const ventaId = req.params.id;
    const rol = (req.query.rol || req.body?.rol || '').toLowerCase();

    if (!['super', 'admin', 'adm', 'vendedor'].includes(rol)) {
        return res.status(403).json({ exito: false, mensaje: 'Permiso denegado. Rol no autorizado.' });
    }

    if (!ventaId) return res.status(400).json({ exito: false, mensaje: 'ID de venta requerido' });

    const validarLimite12Hs = (fechaStr, horaStr) => {
        if (!fechaStr || !horaStr) return true;
        const inicioEvento = new Date(`${fechaStr}T${horaStr}:00`);
        const limiteCancelacion = new Date(inicioEvento.getTime() + (12 * 60 * 60 * 1000));
        return new Date() <= limiteCancelacion;
    };

    if (db) {
        try {
            const vRes = await db.execute({ 
                sql: "SELECT v.*, e.fecha, e.hora FROM ventas v JOIN eventos e ON v.evento_id = e.id WHERE v.id = ?", 
                args: [ventaId] 
            });

            if (vRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });

            const venta = vRes.rows[0];

            if (!validarLimite12Hs(venta.fecha, venta.hora)) {
                return res.status(403).json({ exito: false, mensaje: 'Límite de tiempo excedido: No se pueden cancelar ventas pasadas las 12hs del inicio del evento.' });
            }

            if (esSobreventa(venta.codigoAsiento)) {
                // Un asiento de sobreventa no se "libera": deja de existir.
                await db.execute({ sql: "DELETE FROM asientos WHERE id = ?", args: [venta.asiento_id] });
            } else {
                await db.execute({ sql: "UPDATE asientos SET vendido = 0, asistio = 0 WHERE id = ?", args: [venta.asiento_id] });
            }
            await db.execute({ sql: "DELETE FROM ventas WHERE id = ?", args: [ventaId] });

            return res.json({ exito: true, mensaje: 'Venta cancelada exitosamente' });
        } catch (e) {
            return res.status(500).json({ exito: false, mensaje: 'Error al cancelar la venta' });
        }
    } else {
        const indexVenta = ventasMemoria.findIndex(v => v.id == ventaId);
        if (indexVenta === -1) return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });

        const venta = ventasMemoria[indexVenta];
        const evento = eventosMemoria.find(e => e.id === venta.evento_id);

        if (evento && !validarLimite12Hs(evento.fecha, evento.hora)) {
            return res.status(403).json({ exito: false, mensaje: 'Límite de tiempo excedido' });
        }

        const lista = asientosMemoria[venta.evento_id] || [];
        const asiento = lista.find(a => a.id === venta.asiento_id);
        if (asiento && esSobreventa(asiento.codigoAsiento)) {
            asientosMemoria[venta.evento_id] = lista.filter(a => a.id !== asiento.id);
        } else if (asiento) { asiento.vendido = 0; asiento.asistio = 0; }

        ventasMemoria.splice(indexVenta, 1);
        return res.json({ exito: true, mensaje: 'Venta cancelada exitosamente (Memoria)' });
    }
});

app.get('/api/informe/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    if (db) {
        try {
            const ventasRes = await db.execute({ sql: "SELECT * FROM ventas WHERE evento_id = ?", args: [eventoId] });
            const asientosRes = await db.execute({ sql: "SELECT * FROM asientos WHERE evento_id = ?", args: [eventoId] });

            const vendidas = ventasRes.rows.length;
            const recaudado = ventasRes.rows.reduce((acc, curr) => acc + Number(curr.monto_total), 0);
            const asistentes = asientosRes.rows.filter(a => Number(a.vendido) === 1 && Number(a.asistio) === 1).length;

            return res.json({ vendidas, asistentes, recaudado });
        } catch (e) { console.error(e); }
    }

    const ventasEvento = ventasMemoria.filter(v => v.evento_id === eventoId);
    const listaAsientos = asientosMemoria[eventoId] || [];
    const vendidas = ventasEvento.length;
    const recaudado = ventasEvento.reduce((acc, curr) => acc + Number(curr.monto_total), 0);
    const asistentes = listaAsientos.filter(a => Number(a.vendido) === 1 && Number(a.asistio) === 1).length;

    res.json({ vendidas, asistentes, recaudado });
});

app.get(['/api/reportes/consolidado', '/api/eventos/reporte-general'], async (req, res) => {
    if (db) {
        try {
            const result = await db.execute(`
                SELECT 
                    e.id as id,
                    e.id as evento_id,
                    e.nombre as nombre,
                    e.nombre as evento_nombre,
                    e.fecha,
                    e.hora,
                    COALESCE(v.vendidas, 0) as vendidas,
                    COALESCE(v.recaudado, 0) as recaudado,
                    COALESCE(v.descuento, 0) as descuento,
                    COALESCE(a.asistentes, 0) as asistentes
                FROM eventos e
                LEFT JOIN (
                    SELECT 
                        ventas.evento_id as evento_id, 
                        COUNT(ventas.id) as vendidas, 
                        SUM(ventas.monto_total) as recaudado,
                        SUM(CASE WHEN asientos.precio > ventas.monto_total THEN asientos.precio - ventas.monto_total ELSE 0 END) as descuento
                    FROM ventas 
                    LEFT JOIN asientos ON asientos.id = ventas.asiento_id
                    GROUP BY ventas.evento_id
                ) v ON e.id = v.evento_id
                LEFT JOIN (
                    SELECT 
                        evento_id, 
                        COUNT(id) as asistentes 
                    FROM asientos 
                    WHERE asistio = 1 OR asistio = '1'
                    GROUP BY evento_id
                ) a ON e.id = a.evento_id
                ORDER BY e.fecha DESC
            `);
            return res.json(result.rows);
        } catch (e) {
            console.error("Error reporte consolidado:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al generar reporte consolidado' });
        }
    } else {
        const reportes = eventosMemoria.map(e => {
            const ventas = ventasMemoria.filter(v => v.evento_id === e.id);
            const listaAsientos = asientosMemoria[e.id] || [];
            
            const totalAsistentes = listaAsientos.filter(a => a.asistio == 1 || a.asistio === true).length;
            const totalRecaudado = ventas.reduce((acc, v) => acc + Number(v.monto_total || 0), 0);
            // Descuento = precio de lista del asiento menos lo efectivamente cobrado.
            const totalDescuento = ventas.reduce((acc, v) => {
                const a = listaAsientos.find(x => x.id === v.asiento_id);
                const dif = a ? Number(a.precio) - Number(v.monto_total || 0) : 0;
                return acc + (dif > 0 ? dif : 0);
            }, 0);

            return {
                id: e.id,
                evento_id: e.id,
                nombre: e.nombre,
                fecha: e.fecha,
                hora: e.hora,
                vendidas: ventas.length,
                recaudado: totalRecaudado,
                descuento: totalDescuento,
                asistentes: totalAsistentes
            };
        });
        return res.json(reportes);
    }
});

app.get('/api/ventas/detalle/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    const esTodos = !eventoId || eventoId.toUpperCase() === 'TODOS';

    if (db) {
        try {
            const sql = esTodos 
                ? `SELECT v.id, v.nombre, v.apellido, v.email, v.contacto as telefono, 
                          v.codigoAsiento, v.monto_total, v.metodo_pago, v.vendedor, v.fechaCompra, v.evento_id, v.asiento_id,
                          v.cupon_codigo, a.asistio, e.nombre as eventoNombre
                   FROM ventas v
                   LEFT JOIN asientos a ON v.asiento_id = a.id
                   LEFT JOIN eventos e ON v.evento_id = e.id
                   ORDER BY v.id DESC`
                : `SELECT v.id, v.nombre, v.apellido, v.email, v.contacto as telefono, 
                          v.codigoAsiento, v.monto_total, v.metodo_pago, v.vendedor, v.fechaCompra, v.evento_id, v.asiento_id,
                          v.cupon_codigo, a.asistio
                   FROM ventas v
                   LEFT JOIN asientos a ON v.asiento_id = a.id
                   WHERE v.evento_id = ?
                   ORDER BY v.id DESC`;

            const args = esTodos ? [] : [eventoId];
            const result = await db.execute({ sql, args });

            const ventasConFirma = result.rows.map(v => ({
                ...v,
                sig: generarFirma(v.id, v.codigoAsiento)
            }));

            return res.json(ventasConFirma);
        } catch (e) {
            console.error("Error al consultar detalles de ventas:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al consultar ventas' });
        }
    } else {
        const todasVentas = typeof ventasMemoria !== 'undefined' ? ventasMemoria : [];
        const ventasFiltradas = esTodos ? todasVentas : todasVentas.filter(v => v.evento_id === eventoId);

        const lista = ventasFiltradas.map(v => {
            const listaAsientos = (typeof asientosMemoria !== 'undefined' && asientosMemoria[v.evento_id]) || [];
            const asientoObj = listaAsientos.find(a => a.id === v.asiento_id);
            const eventoObj = (typeof eventosMemoria !== 'undefined' && eventosMemoria.find(e => e.id === v.evento_id)) || {};

            return {
                id: v.id,
                nombre: v.nombre,
                apellido: v.apellido,
                email: v.email,
                telefono: v.contacto,
                codigoAsiento: v.codigoAsiento,
                monto_total: v.monto_total,
                metodo_pago: v.metodo_pago || v.metodoPago || 'efectivo',
                vendedor: v.vendedor || v.usuario_vendedor || 'Sistema',
                fechaCompra: v.fechaCompra,
                evento_id: v.evento_id,
                asiento_id: v.asiento_id,
                asistio: asientoObj ? Number(asientoObj.asistio) : 0,
                eventoNombre: eventoObj.nombre || v.evento_id,
                cupon_codigo: v.cupon_codigo || null,
                sig: generarFirma(v.id, v.codigoAsiento)
            };
        });
        res.json(lista);
    }
});

// FUNCIÓN AUXILIAR PARA AJUSTAR ASIENTOS (AMPLIAR O ACHICAR SIN PERDER ASIENTOS VENDIDOS)
async function ajustarAsientosEvento(eventoId, pGen, dispGen, pGrada, dispGrada) {
    const newGen = Math.min(Math.max(Number(dispGen) || 0, 0), 112);
    const newGrada = Math.min(Math.max(Number(dispGrada) || 0, 0), 24);

    if (db) {
        const resA = await db.execute({ sql: "SELECT * FROM asientos WHERE evento_id = ?", args: [eventoId] });
        const asientosExistentes = resA.rows || [];

        // 1. Actualizar precios de asientos no vendidos
        await db.execute({ sql: "UPDATE asientos SET precio = ? WHERE evento_id = ? AND (tipoZona = 'General' OR codigoAsiento LIKE 'GEN-%') AND vendido = 0", args: [pGen, eventoId] });
        await db.execute({ sql: "UPDATE asientos SET precio = ? WHERE evento_id = ? AND (tipoZona = 'Grada' OR codigoAsiento LIKE 'G1-%' OR codigoAsiento LIKE 'G2-%') AND vendido = 0", args: [pGrada, eventoId] });

        // --- ZONA GENERAL ---
        const genExistentes = asientosExistentes.filter(a => a.tipoZona === 'General' || a.codigoAsiento.startsWith('GEN-'));
        const cantGenActual = genExistentes.length;

        if (newGen > cantGenActual) {
            for (let i = cantGenActual + 1; i <= newGen; i++) {
                const codigo = codigoGeneral(i);
                if (!genExistentes.some(a => a.codigoAsiento === codigo)) {
                    await db.execute({
                        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, 'General', ?, 0, 1, 0)",
                        args: [eventoId, codigo, pGen]
                    });
                }
            }
        } else if (newGen < cantGenActual) {
            const aRemover = cantGenActual - newGen;
            const genNoVendidos = genExistentes
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGeneral(a.codigoAsiento);
                    const numB = indiceGeneral(b.codigoAsiento);
                    return numB - numA;
                });

            const aEliminar = genNoVendidos.slice(0, aRemover);
            for (const a of aEliminar) {
                await db.execute({
                    sql: "DELETE FROM asientos WHERE id = ? AND vendido = 0",
                    args: [a.id]
                });
            }
        }

        // --- ZONA GRADAS ---
        const g1Existentes = asientosExistentes.filter(a => a.codigoAsiento.startsWith('G1-'));
        const g2Existentes = asientosExistentes.filter(a => a.codigoAsiento.startsWith('G2-'));

        const soldG1 = g1Existentes.filter(a => Number(a.vendido) === 1).length;
        const soldG2 = g2Existentes.filter(a => Number(a.vendido) === 1).length;

        let targetG1 = Math.ceil(newGrada / 2);
        let targetG2 = newGrada - targetG1;

        if (targetG1 < soldG1) {
            targetG1 = soldG1;
            targetG2 = newGrada - targetG1;
        } else if (targetG2 < soldG2) {
            targetG2 = soldG2;
            targetG1 = newGrada - targetG2;
        }

        // Ajustar Grada 1
        const cantG1Actual = g1Existentes.length;
        if (targetG1 > cantG1Actual) {
            for (let i = cantG1Actual + 1; i <= targetG1; i++) {
                const codigo = codigoGrada(1, i);
                if (!g1Existentes.some(a => a.codigoAsiento === codigo)) {
                    await db.execute({
                        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, 'Grada', ?, 0, 1, 0)",
                        args: [eventoId, codigo, pGrada]
                    });
                }
            }
        } else if (targetG1 < cantG1Actual) {
            const removerG1 = cantG1Actual - targetG1;
            const g1NoVendidos = g1Existentes
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGrada(a.codigoAsiento);
                    const numB = indiceGrada(b.codigoAsiento);
                    return numB - numA;
                });
            const aEliminarG1 = g1NoVendidos.slice(0, removerG1);
            for (const a of aEliminarG1) {
                await db.execute({
                    sql: "DELETE FROM asientos WHERE id = ? AND vendido = 0",
                    args: [a.id]
                });
            }
        }

        // Ajustar Grada 2
        const cantG2Actual = g2Existentes.length;
        if (targetG2 > cantG2Actual) {
            for (let i = cantG2Actual + 1; i <= targetG2; i++) {
                const codigo = codigoGrada(2, i);
                if (!g2Existentes.some(a => a.codigoAsiento === codigo)) {
                    await db.execute({
                        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, 'Grada', ?, 0, 1, 0)",
                        args: [eventoId, codigo, pGrada]
                    });
                }
            }
        } else if (targetG2 < cantG2Actual) {
            const removerG2 = cantG2Actual - targetG2;
            const g2NoVendidos = g2Existentes
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGrada(a.codigoAsiento);
                    const numB = indiceGrada(b.codigoAsiento);
                    return numB - numA;
                });
            const aEliminarG2 = g2NoVendidos.slice(0, removerG2);
            for (const a of aEliminarG2) {
                await db.execute({
                    sql: "DELETE FROM asientos WHERE id = ? AND vendido = 0",
                    args: [a.id]
                });
            }
        }
    } else {
        // --- MODO MEMORIA TEMPORAL ---
        if (!asientosMemoria[eventoId]) asientosMemoria[eventoId] = [];
        const lista = asientosMemoria[eventoId];

        lista.forEach(a => {
            if (Number(a.vendido) === 0) {
                if (a.tipoZona === 'General' || a.codigoAsiento.startsWith('GEN-')) a.precio = pGen;
                if (a.tipoZona === 'Grada' || a.codigoAsiento.startsWith('G1-') || a.codigoAsiento.startsWith('G2-')) a.precio = pGrada;
            }
        });

        // General Memoria
        const genExistentes = lista.filter(a => a.tipoZona === 'General' || a.codigoAsiento.startsWith('GEN-'));
        const cantGenActual = genExistentes.length;

        if (newGen > cantGenActual) {
            let maxId = lista.reduce((max, item) => item.id > max ? item.id : max, 0);
            for (let i = cantGenActual + 1; i <= newGen; i++) {
                const codigo = codigoGeneral(i);
                if (!genExistentes.some(a => a.codigoAsiento === codigo)) {
                    lista.push({
                        id: ++maxId,
                        codigoAsiento: codigo,
                        tipoZona: 'General',
                        precio: pGen,
                        vendido: 0,
                        habilitado: 1,
                        asistio: 0
                    });
                }
            }
        } else if (newGen < cantGenActual) {
            const aRemover = cantGenActual - newGen;
            const genNoVendidos = genExistentes
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGeneral(a.codigoAsiento);
                    const numB = indiceGeneral(b.codigoAsiento);
                    return numB - numA;
                });
            const idsAEliminar = new Set(genNoVendidos.slice(0, aRemover).map(a => a.id));
            asientosMemoria[eventoId] = lista.filter(a => !idsAEliminar.has(a.id));
        }

        // Gradas Memoria
        const listaActualizada = asientosMemoria[eventoId];
        const g1Existentes = listaActualizada.filter(a => a.codigoAsiento.startsWith('G1-'));
        const g2Existentes = listaActualizada.filter(a => a.codigoAsiento.startsWith('G2-'));

        const soldG1 = g1Existentes.filter(a => Number(a.vendido) === 1).length;
        const soldG2 = g2Existentes.filter(a => Number(a.vendido) === 1).length;

        let targetG1 = Math.ceil(newGrada / 2);
        let targetG2 = newGrada - targetG1;

        if (targetG1 < soldG1) {
            targetG1 = soldG1;
            targetG2 = newGrada - targetG1;
        } else if (targetG2 < soldG2) {
            targetG2 = soldG2;
            targetG1 = newGrada - targetG2;
        }

        let maxId = listaActualizada.reduce((max, item) => item.id > max ? item.id : max, 0);

        const cantG1Actual = g1Existentes.length;
        if (targetG1 > cantG1Actual) {
            for (let i = cantG1Actual + 1; i <= targetG1; i++) {
                const codigo = codigoGrada(1, i);
                if (!g1Existentes.some(a => a.codigoAsiento === codigo)) {
                    asientosMemoria[eventoId].push({
                        id: ++maxId,
                        codigoAsiento: codigo,
                        tipoZona: 'Grada',
                        precio: pGrada,
                        vendido: 0,
                        habilitado: 1,
                        asistio: 0
                    });
                }
            }
        } else if (targetG1 < cantG1Actual) {
            const removerG1 = cantG1Actual - targetG1;
            const g1NoVendidos = g1Existentes
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGrada(a.codigoAsiento);
                    const numB = indiceGrada(b.codigoAsiento);
                    return numB - numA;
                });
            const idsAEliminar = new Set(g1NoVendidos.slice(0, removerG1).map(a => a.id));
            asientosMemoria[eventoId] = asientosMemoria[eventoId].filter(a => !idsAEliminar.has(a.id));
        }

        const listaPostG1 = asientosMemoria[eventoId];
        const g2Actuales = listaPostG1.filter(a => a.codigoAsiento.startsWith('G2-'));
        const cantG2Actual = g2Actuales.length;

        if (targetG2 > cantG2Actual) {
            for (let i = cantG2Actual + 1; i <= targetG2; i++) {
                const codigo = codigoGrada(2, i);
                if (!g2Actuales.some(a => a.codigoAsiento === codigo)) {
                    asientosMemoria[eventoId].push({
                        id: ++maxId,
                        codigoAsiento: codigo,
                        tipoZona: 'Grada',
                        precio: pGrada,
                        vendido: 0,
                        habilitado: 1,
                        asistio: 0
                    });
                }
            }
        } else if (targetG2 < cantG2Actual) {
            const removerG2 = cantG2Actual - targetG2;
            const g2NoVendidos = g2Actuales
                .filter(a => Number(a.vendido) === 0)
                .sort((a, b) => {
                    const numA = indiceGrada(a.codigoAsiento);
                    const numB = indiceGrada(b.codigoAsiento);
                    return numB - numA;
                });
            const idsAEliminar = new Set(g2NoVendidos.slice(0, removerG2).map(a => a.id));
            asientosMemoria[eventoId] = asientosMemoria[eventoId].filter(a => !idsAEliminar.has(a.id));
        }
    }
}

// EDITAR / ACTUALIZAR EVENTO
// EDITAR / ACTUALIZAR EVENTO
app.put('/api/eventos/editar/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        nombre, 
        fecha, 
        hora, 
        precioGeneral, 
        precioGradas, 
        nuevoAforoGeneral, 
        nuevoAforoGradas, 
        rol 
    } = req.body;

    const esAdmin = ['super', 'admin', 'adm', 'administrador'].includes((rol || '').toLowerCase());
    if (!esAdmin) {
        return res.status(403).json({ exito: false, mensaje: 'No tienes permisos de administrador.' });
    }

    const validarLimite2Hs = (fechaStr, horaStr) => {
        if (!fechaStr || !horaStr) return true;
        const inicioEvento = new Date(`${fechaStr}T${horaStr}:00`);
        const limiteEdicion = new Date(inicioEvento.getTime() + (2 * 60 * 60 * 1000));
        return new Date() <= limiteEdicion;
    };

    if (db) {
        try {
            // 1. Obtener datos actuales del evento en la base de datos (incluyendo fecha y hora)
            const eventoActual = await db.execute({
                sql: "SELECT fecha, hora, dispGen, dispGrada FROM eventos WHERE id = ?",
                args: [id]
            });

            if (eventoActual.rows.length === 0) {
                return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado.' });
            }

            const { fecha: fechaEv, hora: horaEv } = eventoActual.rows[0];

            // Validar restricción de 2 horas transcurridas
            if (!validarLimite2Hs(fechaEv, horaEv)) {
                return res.status(403).json({ 
                    exito: false, 
                    mensaje: 'No es posible editar el evento: Han transcurrido más de 2 horas desde el inicio del mismo.' 
                });
            }

            const aforoActualGen = Number(eventoActual.rows[0].dispGen) || 0;
            const aforoActualGrada = Number(eventoActual.rows[0].dispGrada) || 0;

            const pGen = Number(precioGeneral) || 0;
            const pGrada = Number(precioGradas) || 0;
            const nGen = Number(nuevoAforoGeneral);
            const nGrada = Number(nuevoAforoGradas);

            // 2. Validaciones de aforo
            if (nGen < aforoActualGen) {
                return res.status(400).json({ exito: false, mensaje: `No se puede reducir el aforo general (${nGen}). El mínimo permitido es ${aforoActualGen}.` });
            }
            if (nGrada < aforoActualGrada) {
                return res.status(400).json({ exito: false, mensaje: `No se puede reducir el aforo de gradas (${nGrada}). El mínimo permitido es ${aforoActualGrada}.` });
            }

            if (nGen > 112) {
                return res.status(400).json({ exito: false, mensaje: 'El aforo general no puede ser mayor a 112.' });
            }
            if (nGrada > 24) {
                return res.status(400).json({ exito: false, mensaje: 'El aforo de gradas no puede ser mayor a 24.' });
            }

            // 3. Actualizar tabla de eventos
            await db.execute({
                sql: "UPDATE eventos SET nombre = ?, fecha = ?, hora = ?, precioGeneral = ?, dispGen = ?, precioGradas = ?, dispGrada = ? WHERE id = ?",
                args: [nombre, fecha, hora, pGen, nGen, pGrada, nGrada, id]
            });

            // 4. Sincronizar asientos
            await ajustarAsientosEvento(id, pGen, nGen, pGrada, nGrada);

            return res.json({ exito: true, mensaje: 'Evento actualizado correctamente.' });

        } catch (e) {
            console.error("Error al actualizar evento:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al actualizar: ' + e.message });
        }
    } else {
        // Soporte para Modo Memoria Temporal
        const evento = eventosMemoria.find(e => e.id === id);
        if (!evento) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado.' });

        if (!validarLimite2Hs(evento.fecha, evento.hora)) {
            return res.status(403).json({ 
                exito: false, 
                mensaje: 'No es posible editar el evento: Han transcurrido más de 2 horas desde el inicio del mismo.' 
            });
        }

        const pGen = Number(precioGeneral) || 0;
        const pGrada = Number(precioGradas) || 0;
        const nGen = Number(nuevoAforoGeneral);
        const nGrada = Number(nuevoAforoGradas);

        if (nGen < evento.dispGen) {
            return res.status(400).json({ exito: false, mensaje: `No se puede reducir el aforo general.` });
        }
        if (nGrada < evento.dispGrada) {
            return res.status(400).json({ exito: false, mensaje: `No se puede reducir el aforo de gradas.` });
        }

        evento.nombre = nombre;
        evento.fecha = fecha;
        evento.hora = hora;
        evento.precioGeneral = pGen;
        evento.precioGradas = pGrada;
        evento.dispGen = nGen;
        evento.dispGrada = nGrada;

        await ajustarAsientosEvento(id, pGen, nGen, pGrada, nGrada);
        return res.json({ exito: true, mensaje: 'Evento actualizado correctamente (Memoria).' });
    }
});


// ELIMINAR EVENTO
app.delete('/api/eventos/eliminar/:id', async (req, res) => {
    const { id } = req.params;
    const rol = (req.body?.rol || req.query?.rol || '').toLowerCase();

    if (!['super', 'admin', 'adm'].includes(rol)) {
        return res.status(403).json({ exito: false, mensaje: 'Sin autorización para eliminar eventos.' });
    }

    const validarLimite2Hs = (fechaStr, horaStr) => {
        if (!fechaStr || !horaStr) return true;
        const inicioEvento = new Date(`${fechaStr}T${horaStr}:00`);
        const limiteEliminacion = new Date(inicioEvento.getTime() + (2 * 60 * 60 * 1000));
        return new Date() <= limiteEliminacion;
    };

    if (db) {
        try {
            // Consulta de fecha y hora antes de proceder con la eliminación
            const evRes = await db.execute({ sql: "SELECT fecha, hora FROM eventos WHERE id = ?", args: [id] });
            if (evRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado.' });

            const { fecha, hora } = evRes.rows[0];

            if (!validarLimite2Hs(fecha, hora)) {
                return res.status(403).json({ 
                    exito: false, 
                    mensaje: 'No es posible eliminar el evento: Han transcurrido más de 2 horas desde el inicio del mismo.' 
                });
            }

            await db.execute({ sql: "DELETE FROM ventas WHERE evento_id = ?", args: [id] });
            await db.execute({ sql: "DELETE FROM asientos WHERE evento_id = ?", args: [id] });
            await db.execute({ sql: "DELETE FROM cupones WHERE evento_id = ?", args: [id] });
            await db.execute({ sql: "DELETE FROM eventos WHERE id = ?", args: [id] });
            return res.json({ exito: true, mensaje: 'Evento eliminado correctamente' });
        } catch (e) {
            return res.status(500).json({ exito: false, mensaje: 'Error al eliminar el evento' });
        }
    } else {
        const evento = eventosMemoria.find(e => e.id === id);
        if (!evento) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado.' });

        if (!validarLimite2Hs(evento.fecha, evento.hora)) {
            return res.status(403).json({ 
                exito: false, 
                mensaje: 'No es posible eliminar el evento: Han transcurrido más de 2 horas desde el inicio del mismo.' 
            });
        }

        eventosMemoria = eventosMemoria.filter(e => e.id !== id);
        delete asientosMemoria[id];
        ventasMemoria = ventasMemoria.filter(v => v.evento_id !== id);
        return res.json({ exito: true, mensaje: 'Evento eliminado (Memoria)' });
    }
});
app.put('/api/ventas/editar', async (req, res) => {
    const { ventaId, nombre, apellido, contacto, email, nuevoAsientoId } = req.body;

    const validarLimite2Hs = (fechaStr, horaStr) => {
        if (!fechaStr || !horaStr) return true;
        const inicioEvento = new Date(`${fechaStr}T${horaStr}:00`);
        const limiteEdicion = new Date(inicioEvento.getTime() + (2 * 60 * 60 * 1000));
        return new Date() <= limiteEdicion;
    };

    if (db) {
        try {
            const vRes = await db.execute({ 
                sql: "SELECT v.*, e.fecha, e.hora FROM ventas v JOIN eventos e ON v.evento_id = e.id WHERE v.id = ?", 
                args: [ventaId] 
            });

            if (vRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });
            const venta = vRes.rows[0];

            if (!validarLimite2Hs(venta.fecha, venta.hora)) {
                return res.status(403).json({ 
                    exito: false, 
                    mensaje: 'No es posible editar la venta: Han transcurrido más de 2 horas desde el inicio del evento.' 
                });
            }

            let borrarSobreDespues = null;
            if (nuevoAsientoId && Number(nuevoAsientoId) !== Number(venta.asiento_id)) {
                const aViejoRes = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ?", args: [venta.asiento_id] });
                const aNuevoRes = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ?", args: [nuevoAsientoId] });

                if (aNuevoRes.rows.length === 0) {
                    return res.status(400).json({ exito: false, mensaje: 'El nuevo asiento seleccionado no existe.' });
                }

                const asientoNuevo = aNuevoRes.rows[0];

                if (asientoNuevo.vendido === 1) {
                    return res.status(400).json({ exito: false, mensaje: 'El nuevo asiento seleccionado ya está ocupado.' });
                }

                if (aViejoRes.rows.length > 0) {
                    const asientoViejo = aViejoRes.rows[0];
                    
                    const zonaDe = (z) => (z === 'Sobreventa' ? 'General' : z); // una entrada sin asignar equivale a General
                    if (zonaDe(asientoViejo.tipoZona) !== zonaDe(asientoNuevo.tipoZona)) {
                        return res.status(400).json({ 
                            exito: false, 
                            mensaje: 'Solo puedes cambiar entre asientos de la misma categoría (General a General / Grada a Grada). Para cambiar de categoría, cancela la venta y regístrala nuevamente.' 
                        });
                    }

                    if (esSobreventa(asientoViejo.codigoAsiento)) borrarSobreDespues = asientoViejo.id;
                    else await db.execute({ sql: "UPDATE asientos SET vendido = 0 WHERE id = ?", args: [asientoViejo.id] });
                }

                await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [nuevoAsientoId] });

                await db.execute({
                    sql: "UPDATE ventas SET asiento_id = ?, codigoAsiento = ? WHERE id = ?",
                    args: [nuevoAsientoId, asientoNuevo.codigoAsiento, ventaId]
                });
                if (borrarSobreDespues) await db.execute({ sql: "DELETE FROM asientos WHERE id = ?", args: [borrarSobreDespues] });
            }

            await db.execute({
                sql: "UPDATE ventas SET nombre = ?, apellido = ?, contacto = ?, email = ? WHERE id = ?",
                args: [nombre, apellido, contacto, email || '', ventaId]
            });

            return res.json({ exito: true, mensaje: 'Venta actualizada correctamente' });
        } catch (e) {
            console.error("Error al actualizar la venta:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al actualizar la venta' });
        }
    } else {
        const venta = ventasMemoria.find(x => x.id == ventaId);
        if (!venta) return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });

        const evento = eventosMemoria.find(e => e.id === venta.evento_id);
        if (evento && !validarLimite2Hs(evento.fecha, evento.hora)) {
            return res.status(403).json({ 
                exito: false, 
                mensaje: 'No es posible editar la venta: Han transcurrido más de 2 horas desde el inicio del evento.' 
            });
        }

        if (nuevoAsientoId && Number(nuevoAsientoId) !== Number(venta.asiento_id)) {
            const lista = asientosMemoria[venta.evento_id] || [];
            const asientoViejo = lista.find(a => a.id === venta.asiento_id);
            const asientoNuevo = lista.find(a => a.id == nuevoAsientoId);

            if (!asientoNuevo) {
                return res.status(400).json({ exito: false, mensaje: 'El nuevo asiento seleccionado no existe.' });
            }

            if (asientoNuevo.vendido === 1) {
                return res.status(400).json({ exito: false, mensaje: 'El nuevo asiento seleccionado ya está ocupado.' });
            }

            const zonaDeM = (z) => (z === 'Sobreventa' ? 'General' : z);
            if (asientoViejo && zonaDeM(asientoViejo.tipoZona) !== zonaDeM(asientoNuevo.tipoZona)) {
                return res.status(400).json({ 
                    exito: false, 
                    mensaje: 'Solo puedes cambiar entre asientos de la misma categoría (General a General / Grada a Grada). Para cambiar de categoría, cancela la venta y regístrala nuevamente.' 
                });
            }

            if (asientoViejo && esSobreventa(asientoViejo.codigoAsiento)) asientosMemoria[venta.evento_id] = lista.filter(a => a.id !== asientoViejo.id);
            else if (asientoViejo) asientoViejo.vendido = 0;
            asientoNuevo.vendido = 1;
            venta.asiento_id = asientoNuevo.id;
            venta.codigoAsiento = asientoNuevo.codigoAsiento;
        }

        venta.nombre = nombre;
        venta.apellido = apellido;
        venta.contacto = contacto;
        venta.email = email || '';

        return res.json({ exito: true, mensaje: 'Venta actualizada correctamente (Memoria)' });
    }
});

app.get('/api/entradas/:id', verificarFirmaMiddleware, async (req, res) => {
    const { id } = req.params;
    const { sig } = req.query;

    if (db) {
        try {
            const vRes = await db.execute({
                sql: `SELECT v.*, e.nombre as evento_nombre, e.fecha as evento_fecha, e.hora as evento_hora, a.asistio
                      FROM ventas v
                      JOIN eventos e ON v.evento_id = e.id
                      LEFT JOIN asientos a ON v.asiento_id = a.id
                      WHERE v.id = ?`,
                args: [id]
            });
            if (vRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });

            const venta = vRes.rows[0];

            let estado = 'pendiente';
            const yaIngreso = Number(venta.asistio) === 1;

            if (yaIngreso) {
                estado = 'ingresado';
            } else if (venta.evento_fecha && venta.evento_hora) {
                const inicioEvento = new Date(`${venta.evento_fecha}T${venta.evento_hora}:00`);
                const limite6hs = new Date(inicioEvento.getTime() + (6 * 60 * 60 * 1000));
                if (new Date() > limite6hs) {
                    estado = 'expirado';
                }
            }

            const qrPayload = JSON.stringify({ ticket_id: venta.id, asiento: venta.codigoAsiento, sig });
            const qrCodeUrl = await QRCode.toDataURL(qrPayload);

            return res.json({ exito: true, ticket: { ...venta, estado, qr: qrCodeUrl, sig } });
        } catch (e) {
            console.error("Error al obtener entrada:", e);
            return res.status(500).json({ exito: false, mensaje: 'Error al obtener la entrada' });
        }
    } else {
        const venta = ventasMemoria.find(v => v.id == id);
        if (!venta) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });

        const evento = eventosMemoria.find(e => e.id === venta.evento_id) || {};
        const listaAsientos = asientosMemoria[venta.evento_id] || [];
        const asientoObj = listaAsientos.find(a => a.id === venta.asiento_id);
        const yaIngreso = asientoObj ? Number(asientoObj.asistio) === 1 : false;

        let estado = 'pendiente';
        if (yaIngreso) {
            estado = 'ingresado';
        } else if (evento.fecha && evento.hora) {
            const inicioEvento = new Date(`${evento.fecha}T${evento.hora}:00`);
            const limite6hs = new Date(inicioEvento.getTime() + (6 * 60 * 60 * 1000));
            if (new Date() > limite6hs) {
                estado = 'expirado';
            }
        }

        const qrPayload = JSON.stringify({ ticket_id: venta.id, asiento: venta.codigoAsiento, sig });
        const qrCodeUrl = await QRCode.toDataURL(qrPayload);

        res.json({
            exito: true,
            ticket: {
                ...venta,
                evento_nombre: evento.nombre || 'Evento',
                evento_fecha: evento.fecha || '',
                evento_hora: evento.hora || '',
                estado,
                qr: qrCodeUrl,
                sig
            }
        });
    }
});

app.post('/api/entradas/enviar-email', async (req, res) => {
    const { ventaId } = req.body;

    if (!process.env.BREVO_API_KEY) {
        return res.status(503).json({ exito: false, mensaje: 'El envío de emails no está configurado (falta BREVO_API_KEY).' });
    }

    try {
        let ticketData;
        if (db) {
            const vRes = await db.execute({
                sql: `SELECT v.*, e.nombre as evento_nombre, e.fecha as evento_fecha, e.hora as evento_hora
                      FROM ventas v JOIN eventos e ON v.evento_id = e.id WHERE v.id = ?`,
                args: [ventaId]
            });
            if (vRes.rows.length > 0) ticketData = vRes.rows[0];
        } else {
            const v = ventasMemoria.find(x => x.id == ventaId);
            const e = eventosMemoria.find(x => x.id === (v ? v.evento_id : ''));
            if (v) ticketData = { ...v, evento_nombre: e ? e.nombre : 'Evento', evento_fecha: e ? e.fecha : '', evento_hora: e ? e.hora : '' };
        }

        if (!ticketData || !ticketData.email) {
            return res.json({ exito: false, mensaje: 'El cliente no posee una dirección de correo válida' });
        }

        const sig = generarFirma(ticketData.id, ticketData.codigoAsiento);
        const baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        const ticketUrl = `${baseUrl}/entrada.html?id=${ventaId}&sig=${sig}`;

        const qrPayload = JSON.stringify({ ticket_id: ticketData.id, asiento: ticketData.codigoAsiento, sig });
        const qrDataUrl = await QRCode.toDataURL(qrPayload);

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                sender: { name: 'Boletería Institucional', email: MAIL_REMITENTE },
                to: [{ email: ticketData.email, name: `${ticketData.nombre} ${ticketData.apellido}` }],
                subject: `🎫 Tu Entrada Oficial - ${ticketData.evento_nombre}`,
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <h2 style="color: #0d6efd; text-align: center;">¡Gracias por tu compra!</h2>
                        <p>Hola <strong>${escHtml(ticketData.nombre)} ${escHtml(ticketData.apellido)}</strong>,</p>
                        <p>Aquí tienes el detalle de tu entrada digital para el evento:</p>
                        
                        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0;">
                            <p style="margin: 5px 0;"><strong>Evento:</strong> ${escHtml(ticketData.evento_nombre)}</p>
                            <p style="margin: 5px 0;"><strong>Fecha y Hora:</strong> ${escHtml(ticketData.evento_fecha)} - ${escHtml(ticketData.evento_hora)} hs</p>
                            <p style="margin: 5px 0;"><strong>Asiento / Ubicación:</strong> <span style="color: #0d6efd; font-weight: bold;">${escHtml(etiquetaAsiento(ticketData.codigoAsiento))}</span></p>
                        </div>

                        <div style="text-align: center; margin: 20px 0;">
                            <img src="${qrDataUrl}" alt="Código QR de Entrada" style="width: 200px; height: 200px;" /><br/>
                            <small style="color: #6c757d;">Muestra este código QR en el ingreso</small>
                        </div>

                        <div style="text-align: center; margin-top: 25px;">
                            <a href="${ticketUrl}" style="background-color: #0d6efd; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Ver Entrada Online</a>
                        </div>
                    </div>
                `
            })
        });

        const resData = await response.json();
        if (!response.ok) {
            return res.status(500).json({ exito: false, mensaje: resData.message || 'Error al enviar por Brevo' });
        }

        res.json({ exito: true, mensaje: 'Email enviado exitosamente' });
    } catch (e) {
        res.status(500).json({ exito: false, mensaje: 'Error al enviar el correo electrónico' });
    }
});

// Endpoints Superusuario
app.post('/api/usuarios/crear', async (req, res) => {
    const n = req.body || {};
    const usuario = String(n.usuario || '').trim();
    const clave = String(n.clave || '');
    const tipo = String(n.tipo || '').toLowerCase();
    const identificacion = String(n.identificacion || '').trim();

    if (!usuario || !clave) return res.json({ exito: false, mensaje: 'Usuario y contraseña son obligatorios.' });
    if (clave.length < 4) return res.json({ exito: false, mensaje: 'La contraseña debe tener al menos 4 caracteres.' });
    if (!TIPOS_VALIDOS.includes(tipo)) return res.json({ exito: false, mensaje: 'Tipo de usuario no válido.' });
    // Un administrador común no puede crear superusuarios.
    if (tipo === 'super' && !ROLES_SUPER.includes(req.user.tipo)) {
        return res.status(403).json({ exito: false, mensaje: 'Solo un superusuario puede crear superusuarios.' });
    }
    const claveHash = await hashClave(clave);

    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                args: [usuario, claveHash, tipo, identificacion]
            });
            return res.json({ exito: true, mensaje: 'Usuario guardado' });
        } catch (e) { return res.json({ exito: false, mensaje: 'El usuario ya existe' }); }
    } else {
        if (usuariosMemoria.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) return res.json({ exito: false, mensaje: 'El usuario ya existe' });
        const id = usuariosMemoria.reduce((m, u) => Math.max(m, u.id), 0) + 1;
        usuariosMemoria.push({ id, usuario, clave: claveHash, tipo, identificacion });
        res.json({ exito: true, mensaje: 'Usuario creado (Memoria)' });
    }
});

app.get('/api/super/usuarios', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT id, usuario, tipo, identificacion FROM usuarios");
            return res.json(result.rows);
        } catch (e) { console.error(e); }
    }
    res.json(usuariosMemoria.map(({ id, usuario, tipo, identificacion }) => ({ id, usuario, tipo, identificacion })));
});

// Las contraseñas ya no se pueden ver (se guardan con hash). Se reemplaza por restablecer.
app.post('/api/super/revelar-clave', (req, res) => {
    res.status(410).json({ exito: false, mensaje: 'Las contraseñas ya no se pueden ver. Usá "Restablecer clave".' });
});

app.post('/api/super/restablecer-clave', async (req, res) => {
    const { claveSuper, usuarioIdTarget, nuevaClave } = req.body || {};
    const nueva = String(nuevaClave || '');
    if (nueva.length < 4) return res.json({ exito: false, mensaje: 'La nueva contraseña debe tener al menos 4 caracteres.' });
    try {
        // Se confirma la identidad del superusuario con su propia clave.
        let yo;
        if (db) {
            const r = await db.execute({ sql: "SELECT * FROM usuarios WHERE id = ?", args: [req.user.id] });
            yo = r.rows[0];
        } else {
            yo = usuariosMemoria.find(u => u.id === req.user.id);
        }
        if (!yo || !(await verificarClave(String(claveSuper || ''), yo.clave))) {
            return res.status(403).json({ exito: false, mensaje: 'Tu clave de superusuario es incorrecta.' });
        }
        const hash = await hashClave(nueva);
        if (db) {
            const t = await db.execute({ sql: "UPDATE usuarios SET clave = ? WHERE id = ?", args: [hash, usuarioIdTarget] });
            if (!t.rowsAffected) return res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
        } else {
            const target = usuariosMemoria.find(u => u.id === Number(usuarioIdTarget));
            if (!target) return res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
            target.clave = hash;
        }
        res.json({ exito: true, mensaje: 'Contraseña restablecida.' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ exito: false, mensaje: 'Error al restablecer la contraseña.' });
    }
});

app.delete('/api/super/usuarios/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === Number(req.user.id)) {
        return res.status(400).json({ exito: false, mensaje: 'No podés eliminar tu propio usuario.' });
    }
    if (db) {
        try {
            await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [id] });
            return res.json({ exito: true, mensaje: 'Usuario eliminado' });
        } catch (e) { console.error(e); }
    }
    usuariosMemoria = usuariosMemoria.filter(u => u.id !== id);
    res.json({ exito: true, mensaje: 'Usuario eliminado (Memoria)' });
});

// Puerta Escaneo
app.post('/api/puerta/validar', async (req, res) => {
    try {
        const { id, sig } = req.body;
        if (!id) return res.status(400).json({ exito: false, mensaje: 'Código no recibido.' });

        let ventaId = id;
        let sigRecibida = sig || null;

        if (typeof id === 'string' && id.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(id);
                ventaId = parsed.ticket_id || parsed.id || id;
                sigRecibida = parsed.sig || sigRecibida;
            } catch (e) {}
        }

        if (db) {
            const vRes = await db.execute({
                sql: `SELECT v.*, e.nombre as evento_nombre, e.fecha as evento_fecha, e.hora as evento_hora 
                      FROM ventas v 
                      LEFT JOIN eventos e ON v.evento_id = e.id 
                      WHERE v.id = ? OR v.codigoAsiento = ?`,
                args: [ventaId, ventaId]
            });

            if (vRes.rows.length === 0) return res.json({ exito: false, mensaje: 'Entrada no válida o no encontrada.' });

            const venta = vRes.rows[0];

            if (venta.evento_fecha && venta.evento_hora) {
                const fechaHoraEvento = new Date(`${venta.evento_fecha}T${venta.evento_hora}:00`);
                const aperturaPuertas = new Date(fechaHoraEvento.getTime() - (2 * 60 * 60 * 1000));
                const cierreEvento = new Date(`${venta.evento_fecha}T23:59:59`);
                const horaActual = new Date();

                if (horaActual < aperturaPuertas) {
                    const horaAperturaTexto = aperturaPuertas.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    return res.json({ 
                        exito: false, 
                        mensaje: `⛔ INGRESO NO HABILITADO AÚN<br>Evento: <strong>${escHtml(venta.evento_nombre)}</strong><br>El ingreso habilita a las <strong>${horaAperturaTexto} hs</strong>.` 
                    });
                }

                if (horaActual > cierreEvento) {
                    return res.json({ 
                        exito: false, 
                        mensaje: `⛔ ENTRADA EXPIRADA<br>Esta entrada correspondía al evento del <strong>${escHtml(venta.evento_fecha)}</strong>.` 
                    });
                }
            }

            if (sigRecibida && typeof generarFirma === 'function') {
                if (!firmaValida(sigRecibida, venta.id, venta.codigoAsiento)) {
                    return res.json({ exito: false, mensaje: '¡ALERTA! Entrada falsificada o firma inválida.' });
                }
            }

            const asientoRes = await db.execute({
                sql: "SELECT asistio FROM asientos WHERE id = ?",
                args: [venta.asiento_id]
            });

            if (asientoRes.rows.length > 0 && asientoRes.rows[0].asistio === 1) {
                return res.json({ 
                    exito: false, 
                    mensaje: `ENTRADA YA INGRESADA ANTERIORMENTE.<br>Cliente: ${escHtml(venta.nombre)} ${escHtml(venta.apellido)} (${escHtml(etiquetaAsiento(venta.codigoAsiento))})` 
                });
            }

            await db.execute({
                sql: "UPDATE asientos SET asistio = 1 WHERE id = ?",
                args: [venta.asiento_id]
            });

            return res.json({
                exito: true,
                asiento: etiquetaAsiento(venta.codigoAsiento),
                cliente: `${venta.nombre} ${venta.apellido}`,
                mensaje: 'INGRESO PERMITIDO'
            });

        } else {
            const venta = ventasMemoria.find(v => v.id == ventaId || v.codigoAsiento == ventaId);
            if (!venta) return res.json({ exito: false, mensaje: 'Entrada no válida o no encontrada.' });

            const evento = eventosMemoria.find(e => e.id === venta.evento_id);
            if (evento && evento.fecha && evento.hora) {
                const fechaHoraEvento = new Date(`${evento.fecha}T${evento.hora}:00`);
                const aperturaPuertas = new Date(fechaHoraEvento.getTime() - (2 * 60 * 60 * 1000));
                const cierreEvento = new Date(`${evento.fecha}T23:59:59`);
                const horaActual = new Date();

                if (horaActual < aperturaPuertas) {
                    const horaAperturaTexto = aperturaPuertas.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    return res.json({ 
                        exito: false, 
                        mensaje: `⛔ INGRESO NO HABILITADO AÚN<br>Evento: <strong>${escHtml(evento.nombre)}</strong><br>Habilita a las <strong>${horaAperturaTexto} hs</strong>.` 
                    });
                }

                if (horaActual > cierreEvento) {
                    return res.json({ 
                        exito: false, 
                        mensaje: `⛔ ENTRADA EXPIRADA<br>Pertenecía al evento del <strong>${evento.fecha}</strong>.` 
                    });
                }
            }

            const lista = asientosMemoria[venta.evento_id] || [];
            const asiento = lista.find(a => a.id === venta.asiento_id);

            if (asiento && asiento.asistio === 1) {
                return res.json({ 
                    exito: false, 
                    mensaje: `ENTRADA YA INGRESADA ANTERIORMENTE.<br>Cliente: ${escHtml(venta.nombre)} ${escHtml(venta.apellido)}` 
                });
            }

            if (asiento) asiento.asistio = 1;

            return res.json({
                exito: true,
                asiento: etiquetaAsiento(venta.codigoAsiento),
                cliente: `${venta.nombre} ${venta.apellido}`,
                mensaje: 'INGRESO PERMITIDO'
            });
        }
    } catch (error) {
        return res.status(500).json({ exito: false, mensaje: 'Error interno en el servidor.' });
    }
});

app.get('/puerta.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'puerta.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`===========================================`);
});

