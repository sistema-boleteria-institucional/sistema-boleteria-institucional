const nodemailer = require('nodemailer');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const QRCode = require('qrcode');

const app = express();
const HMAC_SECRET = process.env.HMAC_SECRET || 'llave-secreta-boleteria-super-segura-2026';

// ==========================================
// CONFIGURACIÓN DE NODEMAILER (GMAIL)
// ==========================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.GMAIL_USER || 'gonzalog2019@gmail.com',
        pass: process.env.GMAIL_PASS || 'wwopwhvtbnoxkahn'
    },
    tls: {
        rejectUnauthorized: false
    },
    connectionTimeout: 10000
});

// Middlewares
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// FUNCIONES DE SEGURIDAD (HMAC Y VERIFICACIÓN)
// ==========================================
function generarFirma(ventaId, asientoCodigo) {
    return crypto
        .createHmac('sha256', HMAC_SECRET)
        .update(`${ventaId}:${asientoCodigo}`)
        .digest('hex');
}

function verificarFirmaMiddleware(req, res, next) {
    const { id } = req.params;
    const { sig } = req.query;

    if (!sig) {
        return res.status(403).json({ exito: false, mensaje: 'Firma de seguridad requerida' });
    }

    const verificar = (codigoAsiento) => {
        const firmaEsperada = generarFirma(id, codigoAsiento);
        if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(firmaEsperada))) {
            return next();
        }
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

// ==========================================
// CONEXIÓN A TURSO (PERSISTENCIA REAL)
// ==========================================
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

// Inicializar Tablas en Turso
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
                monto_fijo REAL DEFAULT 0
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS asientos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id TEXT,
                codigoAsiento TEXT,
                tipoZona TEXT,
                precio REAL,
                vendido INTEGER DEFAULT 0,
                habilitado INTEGER DEFAULT 1,
                asistio INTEGER DEFAULT 0
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
                fechaCompra TEXT
            );
        `);

        const resUser = await db.execute("SELECT COUNT(*) as cant FROM usuarios");
        if (resUser.rows[0].cant === 0) {
            await db.execute({
                sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                args: ['admin', '1234', 'super', 'SUP-01']
            });
            await db.execute({
                sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                args: ['operario1', '1234', 'vendedor', 'VEN-01']
            });
        }

        console.log(' Tablas creadas/verificadas en Turso.');
    } catch (e) {
        console.error('Error al inicializar las tablas de Turso:', e);
    }
}

inicializarTablasDB();

// Respaldos en memoria
let usuariosMemoria = [
    { id: 1, usuario: 'admin', clave: '1234', tipo: 'super', identificacion: 'SUP-01' },
    { id: 2, usuario: 'operario1', clave: '1234', tipo: 'vendedor', identificacion: 'VEN-01' }
];
let eventosMemoria = [];
let cuponesMemoria = [{ codigo: 'DESCUENTO10', porcentaje: 10, monto_fijo: 0 }];
let asientosMemoria = {};
let ventasMemoria = [];

// Generar asientos al crear evento
async function generarAsientosParaEvento(eventoObj) {
    const pGen = Number(eventoObj.precioGeneral) || 1500;
    const pGrada = Number(eventoObj.precioGradas) || 3000;
    const totalGen = Math.min(Number(eventoObj.dispGen) || 112, 112);
    const totalGrada = Math.min(Number(eventoObj.dispGrada) || 24, 24);

    if (db) {
        for (let i = 1; i <= totalGen; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, `GEN-A${i}`, 'General', pGen]
            });
        }
        const porG1 = Math.ceil(totalGrada / 2);
        const porG2 = totalGrada - porG1;

        for (let i = 1; i <= porG1; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, `G1-${i}`, 'Grada', pGrada]
            });
        }
        for (let i = 1; i <= porG2; i++) {
            await db.execute({
                sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio, vendido, habilitado, asistio) VALUES (?, ?, ?, ?, 0, 1, 0)",
                args: [eventoObj.id, `G2-${i}`, 'Grada', pGrada]
            });
        }
    } else {
        let lista = [];
        let idCounter = 1;

        for (let i = 1; i <= totalGen; i++) {
            lista.push({ id: idCounter++, codigoAsiento: `GEN-A${i}`, tipoZona: 'General', precio: pGen, vendido: 0, habilitado: 1, asistio: 0 });
        }
        const porG1 = Math.ceil(totalGrada / 2);
        const porG2 = totalGrada - porG1;
        for (let i = 1; i <= porG1; i++) {
            lista.push({ id: idCounter++, codigoAsiento: `G1-${i}`, tipoZona: 'Grada', precio: pGrada, vendido: 0, habilitado: 1, asistio: 0 });
        }
        for (let i = 1; i <= porG2; i++) {
            lista.push({ id: idCounter++, codigoAsiento: `G2-${i}`, tipoZona: 'Grada', precio: pGrada, vendido: 0, habilitado: 1, asistio: 0 });
        }
        asientosMemoria[eventoObj.id] = lista;
    }
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN Y EVENTOS
// ==========================================

app.post('/api/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (db) {
        try {
            const result = await db.execute({
                sql: "SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER(?) AND clave = ?",
                args: [usuario || '', clave || '']
            });
            if (result.rows.length > 0) {
                const u = result.rows[0];
                return res.json({ exito: true, usuario: u.usuario, tipo: u.tipo, id: u.id });
            }
        } catch (e) { console.error(e); }
    } else {
        const usr = usuariosMemoria.find(u => u.usuario.toLowerCase() === (usuario || '').toLowerCase() && u.clave === clave);
        if (usr) return res.json({ exito: true, usuario: usr.usuario, tipo: usr.tipo, id: usr.id });
    }
    res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
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

// Endpoint Único para Crear Cupones
app.post('/api/cupones/crear', async (req, res) => {
    try {
        const { evento_id, codigo, porcentaje, monto_fijo } = req.body;

        if (!evento_id || !codigo) {
            return res.status(400).json({ exito: false, mensaje: 'El evento y el código son obligatorios.' });
        }

        const pct = parseFloat(porcentaje) || 0;
        const monto = parseFloat(monto_fijo) || 0;

        if (pct > 0 && monto > 0) {
            return res.status(400).json({ 
                exito: false, 
                mensaje: 'No puedes aplicar Porcentaje y Monto Fijo simultáneamente.' 
            });
        }

        if (pct === 0 && monto === 0) {
            return res.status(400).json({ 
                exito: false, 
                mensaje: 'El cupón debe tener un Porcentaje o un Monto Fijo mayor a 0.' 
            });
        }

        if (db) {
            await db.execute({
                sql: 'INSERT INTO cupones (evento_id, codigo, porcentaje, monto_fijo) VALUES (?, ?, ?, ?)',
                args: [evento_id, codigo.toUpperCase(), pct, monto]
            });
            return res.json({ exito: true, mensaje: 'Cupón creado con éxito' });
        } else {
            cuponesMemoria.push({ evento_id, codigo: codigo.toUpperCase(), porcentaje: pct, monto_fijo: monto });
            return res.json({ exito: true, mensaje: 'Cupón guardado (Memoria)' });
        }

    } catch (error) {
        console.error("Error en Turso:", error);
        res.status(500).json({ 
            exito: false, 
            mensaje: 'Error al guardar el cupón en Turso: ' + error.message 
        });
    }
});

app.get('/api/eventos/:id/asientos', async (req, res) => {
    const { id } = req.params;
    if (db) {
        try {
            const result = await db.execute({ sql: "SELECT * FROM asientos WHERE evento_id = ?", args: [id] });
            return res.json(result.rows);
        } catch (e) { console.error(e); }
    }
    if (!asientosMemoria[id]) asientosMemoria[id] = [];
    res.json(asientosMemoria[id]);
});

// Obtener cupones filtrados por evento
app.get('/api/cupones/evento/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    if (db) {
        try {
            const result = await db.execute({
                sql: "SELECT * FROM cupones WHERE evento_id = ?",
                args: [eventoId]
            });
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al obtener cupones' });
        }
    } else {
        const lista = cuponesMemoria.filter(c => c.evento_id === eventoId);
        res.json(lista);
    }
});

// Obtener todos los cupones
app.get('/api/cupones', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT * FROM cupones");
            return res.json(result.rows);
        } catch (e) { console.error(e); }
    }
    res.json(cuponesMemoria);
});

app.post('/api/ventas/procesar', async (req, res) => {
    const venta = req.body;
    if (db) {
        try {
            const asientoRes = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ? AND evento_id = ?", args: [venta.asiento_id, venta.evento_id] });
            if (asientoRes.rows.length === 0) return res.json({ exito: false, mensaje: 'Asiento no encontrado' });

            const asiento = asientoRes.rows[0];
            if (asiento.vendido === 1) return res.json({ exito: false, mensaje: 'Asiento ocupado' });

            await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [venta.asiento_id] });

            const insRes = await db.execute({
                sql: "INSERT INTO ventas (evento_id, asiento_id, codigoAsiento, nombre, apellido, contacto, email, metodo_pago, monto_total, fechaCompra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                args: [venta.evento_id, venta.asiento_id, asiento.codigoAsiento, venta.nombre, venta.apellido, venta.contacto, venta.email || '', venta.metodo_pago, venta.monto_total, new Date().toISOString()]
            });

            const nuevaVentaId = insRes.rows[0].id;
            const sig = generarFirma(nuevaVentaId, asiento.codigoAsiento);

            return res.json({ exito: true, mensaje: 'Venta registrada', ventaId: nuevaVentaId, sig });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al procesar la venta' });
        }
    } else {
        const lista = asientosMemoria[venta.evento_id] || [];
        const asiento = lista.find(a => a.id === venta.asiento_id);
        if (!asiento || asiento.vendido === 1) return res.json({ exito: false, mensaje: 'Asiento no disponible' });

        asiento.vendido = 1;
        const nuevaVentaId = ventasMemoria.length + 1;
        ventasMemoria.push({ ...venta, id: nuevaVentaId, codigoAsiento: asiento.codigoAsiento, fechaCompra: new Date().toISOString() });

        const sig = generarFirma(nuevaVentaId, asiento.codigoAsiento);
        res.json({ exito: true, mensaje: 'Venta registrada (Memoria)', ventaId: nuevaVentaId, sig });
    }
});

// CANCELAR VENTA
app.delete('/api/ventas/cancelar/:id', async (req, res) => {
    const ventaId = req.params.id;

    if (!ventaId) {
        return res.status(400).json({ exito: false, mensaje: 'ID de venta requerido' });
    }

    if (db) {
        try {
            const vRes = await db.execute({ sql: "SELECT * FROM ventas WHERE id = ?", args: [ventaId] });
            if (vRes.rows.length === 0) {
                return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });
            }

            const venta = vRes.rows[0];
            const fechaCompra = new Date(venta.fechaCompra);
            const ahora = new Date();
            const diferenciaMinutos = (ahora - fechaCompra) / (1000 * 60);

            if (diferenciaMinutos > 15) {
                return res.status(403).json({ 
                    exito: false, 
                    mensaje: `Tiempo límite excedido para cancelar. Han pasado ${Math.floor(diferenciaMinutos)} minutos (Máximo 15 min).` 
                });
            }

            await db.execute({ sql: "UPDATE asientos SET vendido = 0, asistio = 0 WHERE id = ?", args: [venta.asiento_id] });
            await db.execute({ sql: "DELETE FROM ventas WHERE id = ?", args: [ventaId] });

            return res.json({ exito: true, mensaje: 'Venta cancelada exitosamente y asiento liberado' });
        } catch (e) {
            console.error('Error al cancelar la venta en Turso:', e);
            return res.status(500).json({ exito: false, mensaje: 'Error al procesar la cancelación en la base de datos' });
        }
    } else {
        const indexVenta = ventasMemoria.findIndex(v => v.id == ventaId);
        if (indexVenta === -1) {
            return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });
        }

        const venta = ventasMemoria[indexVenta];
        const fechaCompra = new Date(venta.fechaCompra);
        const ahora = new Date();
        const diferenciaMinutos = (ahora - fechaCompra) / (1000 * 60);

        if (diferenciaMinutos > 15) {
            return res.status(403).json({ 
                exito: false, 
                mensaje: `Tiempo límite excedido para cancelar. Han pasado ${Math.floor(diferenciaMinutos)} minutos (Máximo 15 min).` 
            });
        }

        const lista = asientosMemoria[venta.evento_id] || [];
        const asiento = lista.find(a => a.id === venta.asiento_id);
        if (asiento) {
            asiento.vendido = 0;
            asiento.asistio = 0;
        }

        ventasMemoria.splice(indexVenta, 1);

        return res.json({ exito: true, mensaje: 'Venta cancelada exitosamente y asiento liberado (Memoria)' });
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
            const asistentes = asientosRes.rows.filter(a => a.vendido === 1 && a.asistio === 1).length;

            return res.json({ vendidas, asistentes, recaudado });
        } catch (e) { console.error(e); }
    }

    const ventasEvento = ventasMemoria.filter(v => v.evento_id === eventoId);
    const listaAsientos = asientosMemoria[eventoId] || [];
    const vendidas = ventasEvento.length;
    const recaudado = ventasEvento.reduce((acc, curr) => acc + Number(curr.monto_total), 0);
    const asistentes = listaAsientos.filter(a => a.vendido === 1 && a.asistio === 1).length;

    res.json({ vendidas, asistentes, recaudado });
});

app.get('/api/ventas/detalle/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    if (db) {
        try {
            const result = await db.execute({
                sql: `SELECT v.id, v.nombre, v.apellido, v.email, v.contacto as telefono, 
                             v.codigoAsiento, v.monto_total, v.fechaCompra, v.evento_id, v.asiento_id
                      FROM ventas v
                      WHERE v.evento_id = ?
                      ORDER BY v.id DESC`,
                args: [eventoId]
            });

            const ventasConFirma = result.rows.map(v => ({
                ...v,
                sig: generarFirma(v.id, v.codigoAsiento)
            }));

            return res.json(ventasConFirma);
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al consultar ventas' });
        }
    } else {
        const lista = ventasMemoria
            .filter(v => v.evento_id === eventoId)
            .map(v => ({
                id: v.id,
                nombre: v.nombre,
                apellido: v.apellido,
                email: v.email,
                telefono: v.contacto,
                codigoAsiento: v.codigoAsiento,
                monto_total: v.monto_total,
                fechaCompra: v.fechaCompra,
                evento_id: v.evento_id,
                asiento_id: v.asiento_id,
                sig: generarFirma(v.id, v.codigoAsiento)
            }));
        res.json(lista);
    }
});

app.put('/api/ventas/editar', async (req, res) => {
    const { ventaId, nombre, apellido, contacto, email, nuevoAsientoId } = req.body;

    if (db) {
        try {
            await db.execute({
                sql: "UPDATE ventas SET nombre = ?, apellido = ?, contacto = ?, email = ? WHERE id = ?",
                args: [nombre, apellido, contacto, email || '', ventaId]
            });

            if (nuevoAsientoId) {
                const vRes = await db.execute({ sql: "SELECT asiento_id, evento_id FROM ventas WHERE id = ?", args: [ventaId] });
                if (vRes.rows.length > 0) {
                    const asientoViejoId = vRes.rows[0].asiento_id;

                    const nAsientoRes = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ?", args: [nuevoAsientoId] });
                    if (nAsientoRes.rows.length > 0) {
                        const nuevoAsiento = nAsientoRes.rows[0];

                        if (asientoViejoId) {
                            await db.execute({ sql: "UPDATE asientos SET vendido = 0 WHERE id = ?", args: [asientoViejoId] });
                        }

                        await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [nuevoAsientoId] });

                        await db.execute({
                            sql: "UPDATE ventas SET asiento_id = ?, codigoAsiento = ? WHERE id = ?",
                            args: [nuevoAsientoId, nuevoAsiento.codigoAsiento, ventaId]
                        });
                    }
                }
            }

            return res.json({ exito: true, mensaje: 'Venta actualizada correctamente' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al actualizar la venta' });
        }
    } else {
        const v = ventasMemoria.find(x => x.id == ventaId);
        if (!v) return res.status(404).json({ exito: false, mensaje: 'Venta no encontrada' });

        v.nombre = nombre;
        v.apellido = apellido;
        v.contacto = contacto;
        v.email = email || '';

        if (nuevoAsientoId) {
            const lista = asientosMemoria[v.evento_id] || [];
            const asientoViejo = lista.find(a => a.id === v.asiento_id);
            const asientoNuevo = lista.find(a => a.id == nuevoAsientoId);

            if (asientoViejo) asientoViejo.vendido = 0;
            if (asientoNuevo) {
                asientoNuevo.vendido = 1;
                v.asiento_id = asientoNuevo.id;
                v.codigoAsiento = asientoNuevo.codigoAsiento;
            }
        }

        res.json({ exito: true, mensaje: 'Venta actualizada correctamente (Memoria)' });
    }
});

// Detalle de Entrada protegido con Middleware HMAC
app.get('/api/entradas/:id', verificarFirmaMiddleware, async (req, res) => {
    const { id } = req.params;
    const { sig } = req.query;

    if (db) {
        try {
            const vRes = await db.execute({
                sql: `SELECT v.*, e.nombre as evento_nombre, e.fecha as evento_fecha, e.hora as evento_hora
                      FROM ventas v
                      JOIN eventos e ON v.evento_id = e.id
                      WHERE v.id = ?`,
                args: [id]
            });
            if (vRes.rows.length === 0) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });

            const venta = vRes.rows[0];
            const qrPayload = JSON.stringify({ ticket_id: venta.id, asiento: venta.codigoAsiento, sig });
            const qrCodeUrl = await QRCode.toDataURL(qrPayload);

            return res.json({ exito: true, ticket: { ...venta, qr: qrCodeUrl, sig } });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al obtener la entrada' });
        }
    } else {
        const venta = ventasMemoria.find(v => v.id == id);
        if (!venta) return res.status(404).json({ exito: false, mensaje: 'Entrada no encontrada' });

        const evento = eventosMemoria.find(e => e.id === venta.evento_id) || {};
        const qrPayload = JSON.stringify({ ticket_id: venta.id, asiento: venta.codigoAsiento, sig });
        const qrCodeUrl = await QRCode.toDataURL(qrPayload);

        res.json({
            exito: true,
            ticket: {
                ...venta,
                evento_nombre: evento.nombre || 'Evento',
                evento_fecha: evento.fecha || '',
                evento_hora: evento.hora || '',
                qr: qrCodeUrl,
                sig
            }
        });
    }
});

// Endpoint para enviar entrada por Email (Brevo API)
app.post('/api/entradas/enviar-email', async (req, res) => {
    const { ventaId, hostOrigin } = req.body;

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
        const baseUrl = hostOrigin || 'https://sistema-boleteria-institucional.onrender.com';
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
                sender: { name: 'Boletería Institucional', email: 'gonzalog2019@gmail.com' },
                to: [{ email: ticketData.email, name: `${ticketData.nombre} ${ticketData.apellido}` }],
                subject: `🎫 Tu Entrada Oficial - ${ticketData.evento_nombre}`,
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <h2 style="color: #0d6efd; text-align: center;">¡Gracias por tu compra!</h2>
                        <p>Hola <strong>${ticketData.nombre} ${ticketData.apellido}</strong>,</p>
                        <p>Aquí tienes el detalle de tu entrada digital para el evento:</p>
                        
                        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0;">
                            <p style="margin: 5px 0;"><strong>Evento:</strong> ${ticketData.evento_nombre}</p>
                            <p style="margin: 5px 0;"><strong>Fecha y Hora:</strong> ${ticketData.evento_fecha} - ${ticketData.evento_hora} hs</p>
                            <p style="margin: 5px 0;"><strong>Asiento / Ubicación:</strong> <span style="color: #0d6efd; font-weight: bold;">${ticketData.codigoAsiento}</span></p>
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
            console.error('Error Brevo API:', resData);
            return res.status(500).json({ exito: false, mensaje: resData.message || 'Error al enviar por Brevo' });
        }

        res.json({ exito: true, mensaje: 'Email enviado exitosamente' });
    } catch (e) {
        console.error('Error general al enviar correo:', e);
        res.status(500).json({ exito: false, mensaje: 'Error al enviar el correo electrónico' });
    }
});

// Endpoints Superusuario
app.post('/api/usuarios/crear', async (req, res) => {
    const nuevoUsr = req.body;
    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                args: [nuevoUsr.usuario, nuevoUsr.clave, nuevoUsr.tipo, nuevoUsr.identificacion]
            });
            return res.json({ exito: true, mensaje: 'Usuario guardado' });
        } catch (e) { return res.json({ exito: false, mensaje: 'El usuario ya existe' }); }
    } else {
        if (usuariosMemoria.some(u => u.usuario.toLowerCase() === nuevoUsr.usuario.toLowerCase())) return res.json({ exito: false, mensaje: 'El usuario ya existe' });
        nuevoUsr.id = usuariosMemoria.length + 1;
        usuariosMemoria.push(nuevoUsr);
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
    res.json(usuariosMemoria);
});

app.post('/api/super/revelar-clave', async (req, res) => {
    const { claveSuper, usuarioIdTarget } = req.body;
    if (db) {
        try {
            const superRes = await db.execute({ sql: "SELECT * FROM usuarios WHERE (tipo = 'super' OR tipo = 'admin') AND clave = ?", args: [claveSuper] });
            if (superRes.rows.length === 0) return res.status(403).json({ exito: false, mensaje: 'Clave incorrecta' });

            const targetRes = await db.execute({ sql: "SELECT clave FROM usuarios WHERE id = ?", args: [usuarioIdTarget] });
            if (targetRes.rows.length > 0) return res.json({ exito: true, clave: targetRes.rows[0].clave });
        } catch (e) { console.error(e); }
    } else {
        const superAdmin = usuariosMemoria.find(u => (u.tipo === 'super' || u.tipo === 'admin') && u.clave === claveSuper);
        if (!superAdmin) return res.status(403).json({ exito: false, mensaje: 'Clave incorrecta' });

        const target = usuariosMemoria.find(u => u.id === usuarioIdTarget);
        if (target) return res.json({ exito: true, clave: target.clave });
    }
    res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
});

app.delete('/api/super/usuarios/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (db) {
        try {
            await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [id] });
            return res.json({ exito: true, mensaje: 'Usuario eliminado' });
        } catch (e) { console.error(e); }
    }
    usuariosMemoria = usuariosMemoria.filter(u => u.id !== id);
    res.json({ exito: true, mensaje: 'Usuario eliminado (Memoria)' });
});

// ==========================================
// ENDPOINT PARA CONTROL DE ACCESO (PUERTA)
// ==========================================
app.post('/api/puerta/validar', async (req, res) => {
    try {
        const { id, sig } = req.body;

        if (!id) {
            return res.status(400).json({ exito: false, mensaje: 'Código no recibido.' });
        }

        let ventaId = id;
        let sigRecibida = sig || null;

        // Si el QR contiene un objeto JSON stringificado
        if (typeof id === 'string' && id.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(id);
                ventaId = parsed.ticket_id || parsed.id || id;
                sigRecibida = parsed.sig || sigRecibida;
            } catch (e) {
                // Si no es JSON se procesa tal cual
            }
        }

        if (db) {
            // 1. Buscar la entrada en la base de datos por ID o Código de Asiento
            const vRes = await db.execute({
                sql: `SELECT v.*, e.nombre as evento_nombre 
                      FROM ventas v 
                      LEFT JOIN eventos e ON v.evento_id = e.id 
                      WHERE v.id = ? OR v.codigoAsiento = ?`,
                args: [ventaId, ventaId]
            });

            if (vRes.rows.length === 0) {
                return res.json({ exito: false, mensaje: 'Entrada no válida o no encontrada.' });
            }

            const venta = vRes.rows[0];

            // 2. Validar firma de seguridad (HMAC) si se incluye en el QR
            if (sigRecibida && typeof generarFirma === 'function') {
                const firmaEsperada = generarFirma(venta.id, venta.codigoAsiento);
                if (sigRecibida !== firmaEsperada) {
                    return res.json({ exito: false, mensaje: '¡ALERTA! Entrada falsificada o firma inválida.' });
                }
            }

            // 3. Verificar si el cliente ya ingresó
            const asientoRes = await db.execute({
                sql: "SELECT asistio FROM asientos WHERE id = ?",
                args: [venta.asiento_id]
            });

            if (asientoRes.rows.length > 0 && asientoRes.rows[0].asistio === 1) {
                return res.json({ 
                    exito: false, 
                    mensaje: `ENTRADA YA INGRESA ANTERIORMENTE.<br>Cliente: ${venta.nombre} ${venta.apellido} (${venta.codigoAsiento})` 
                });
            }

            // 4. Marcar como ingresado en la base de datos
            await db.execute({
                sql: "UPDATE asientos SET asistio = 1 WHERE id = ?",
                args: [venta.asiento_id]
            });

            return res.json({
                exito: true,
                asiento: venta.codigoAsiento,
                cliente: `${venta.nombre} ${venta.apellido}`,
                mensaje: 'INGRESO PERMITIDO'
            });

        } else {
            // Manejo en Memoria (Fallback)
            const venta = ventasMemoria.find(v => v.id == ventaId || v.codigoAsiento == ventaId);

            if (!venta) {
                return res.json({ exito: false, mensaje: 'Entrada no válida o no encontrada.' });
            }

            const lista = asientosMemoria[venta.evento_id] || [];
            const asiento = lista.find(a => a.id === venta.asiento_id);

            if (asiento && asiento.asistio === 1) {
                return res.json({ 
                    exito: false, 
                    mensaje: `ENTRADA YA INGRESA ANTERIORMENTE.<br>Cliente: ${venta.nombre} ${venta.apellido} (${venta.codigoAsiento})` 
                });
            }

            if (asiento) asiento.asistio = 1;

            return res.json({
                exito: true,
                asiento: venta.codigoAsiento,
                cliente: `${venta.nombre} ${venta.apellido}`,
                mensaje: 'INGRESO PERMITIDO'
            });
        }

    } catch (error) {
        console.error('Error procesando escaneo en puerta:', error);
        return res.status(500).json({ exito: false, mensaje: 'Error interno en el servidor.' });
    }
});
// ==========================================
// RUTA PROTEGIDA / CONTROL DE ACCESO
// ==========================================
app.get('/puerta.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'puerta.html'));
});

// ==========================================
// ESTA LÍNEA SIEMPRE DEBE IR AL FINAL DE TODO
// ==========================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

