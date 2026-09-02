const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();

// Middlewares
app.use(express.json());
app.use(express.static(__dirname));

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
                codigo TEXT PRIMARY KEY,
                porcentaje REAL
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

        // Insertar usuarios base si la tabla está vacía
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

// ==========================================
// RESPALDO EN MEMORIA (FALLBACK)
// ==========================================
let usuariosMemoria = [
    { id: 1, usuario: 'admin', clave: '1234', tipo: 'super', identificacion: 'SUP-01' },
    { id: 2, usuario: 'operario1', clave: '1234', tipo: 'vendedor', identificacion: 'VEN-01' }
];
let eventosMemoria = [];
let cuponesMemoria = [{ codigo: 'DESCUENTO10', porcentaje: 10 }];
let asientosMemoria = {};
let ventasMemoria = [];

// ==========================================
// FUNCIONES AUXILIARES DE ASIENTOS
// ==========================================
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
// ENDPOINTS
// ==========================================

// 1. Autenticación
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
        } catch (e) {
            console.error(e);
        }
    } else {
        const usr = usuariosMemoria.find(u => u.usuario.toLowerCase() === (usuario || '').toLowerCase() && u.clave === clave);
        if (usr) return res.json({ exito: true, usuario: usr.usuario, tipo: usr.tipo, id: usr.id });
    }

    res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
});

// 2. Obtener Eventos
app.get('/api/eventos', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT * FROM eventos");
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
        }
    }
    res.json(eventosMemoria);
});

// 3. Crear Evento
app.post('/api/eventos/crear', async (req, res) => {
    const nuevoEvento = req.body;

    if (db) {
        try {
            const check = await db.execute({ sql: "SELECT id FROM eventos WHERE id = ?", args: [nuevoEvento.id] });
            if (check.rows.length > 0) {
                return res.json({ exito: false, mensaje: 'El ID del evento ya existe' });
            }

            await db.execute({
                sql: "INSERT INTO eventos (id, nombre, fecha, hora, precioGeneral, dispGen, precioGradas, dispGrada) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                args: [nuevoEvento.id, nuevoEvento.nombre, nuevoEvento.fecha, nuevoEvento.hora, nuevoEvento.precioGeneral, nuevoEvento.dispGen, nuevoEvento.precioGradas, nuevoEvento.dispGrada]
            });

            await generarAsientosParaEvento(nuevoEvento);
            return res.json({ exito: true, mensaje: 'Evento guardado permanentemente en Turso' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al crear evento' });
        }
    } else {
        if (eventosMemoria.some(e => e.id === nuevoEvento.id)) {
            return res.json({ exito: false, mensaje: 'El ID del evento ya existe' });
        }
        eventosMemoria.push(nuevoEvento);
        await generarAsientosParaEvento(nuevoEvento);
        res.json({ exito: true, mensaje: 'Evento creado exitosamente (Memoria)' });
    }
});

// 4. Obtener Asientos
app.get('/api/eventos/:id/asientos', async (req, res) => {
    const { id } = req.params;

    if (db) {
        try {
            const result = await db.execute({ sql: "SELECT * FROM asientos WHERE evento_id = ?", args: [id] });
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
        }
    }

    if (!asientosMemoria[id]) {
        asientosMemoria[id] = [];
    }
    res.json(asientosMemoria[id]);
});

// 5. Validar Cupón
app.post('/api/cupones/validar', async (req, res) => {
    const { codigo } = req.body;

    if (db) {
        try {
            const result = await db.execute({ sql: "SELECT * FROM cupones WHERE UPPER(codigo) = UPPER(?)", args: [codigo || ''] });
            if (result.rows.length > 0) {
                return res.json({ valido: true, porcentaje: result.rows[0].porcentaje });
            }
        } catch (e) {
            console.error(e);
        }
    } else {
        const cup = cuponesMemoria.find(c => c.codigo.toUpperCase() === (codigo || '').toUpperCase());
        if (cup) return res.json({ valido: true, porcentaje: cup.porcentaje });
    }

    res.json({ valido: false, mensaje: 'Cupón no válido o expirado' });
});

// 6. Crear Cupón
app.post('/api/cupones/crear', async (req, res) => {
    const { codigo, porcentaje } = req.body;

    if (db) {
        try {
            await db.execute({ sql: "INSERT INTO cupones (codigo, porcentaje) VALUES (?, ?)", args: [codigo, porcentaje] });
            return res.json({ exito: true, mensaje: 'Cupón guardado exitosamente' });
        } catch (e) {
            return res.json({ exito: false, mensaje: 'El código de cupón ya existe o es inválido' });
        }
    } else {
        if (cuponesMemoria.some(c => c.codigo.toUpperCase() === codigo.toUpperCase())) {
            return res.json({ exito: false, mensaje: 'El código del cupón ya existe' });
        }
        cuponesMemoria.push({ codigo, porcentaje });
        res.json({ exito: true, mensaje: 'Cupón guardado correctamente (Memoria)' });
    }
});

// 7. Procesar Venta
app.post('/api/ventas/procesar', async (req, res) => {
    const venta = req.body;

    if (db) {
        try {
            const asientoRes = await db.execute({ sql: "SELECT * FROM asientos WHERE id = ? AND evento_id = ?", args: [venta.asiento_id, venta.evento_id] });
            if (asientoRes.rows.length === 0) return res.json({ exito: false, mensaje: 'Asiento no encontrado' });

            const asiento = asientoRes.rows[0];
            if (asiento.vendido === 1) return res.json({ exito: false, mensaje: 'El asiento ya está vendido' });

            await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [venta.asiento_id] });

            await db.execute({
                sql: "INSERT INTO ventas (evento_id, asiento_id, codigoAsiento, nombre, apellido, contacto, email, metodo_pago, monto_total, fechaCompra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                args: [venta.evento_id, venta.asiento_id, asiento.codigoAsiento, venta.nombre, venta.apellido, venta.contacto, venta.email || '', venta.metodo_pago, venta.monto_total, new Date().toISOString()]
            });

            return res.json({ exito: true, mensaje: 'Venta registrada y guardada en base de datos' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al procesar la venta' });
        }
    } else {
        const lista = asientosMemoria[venta.evento_id] || [];
        const asiento = lista.find(a => a.id === venta.asiento_id);

        if (!asiento) return res.json({ exito: false, mensaje: 'Asiento no válido' });
        if (asiento.vendido === 1) return res.json({ exito: false, mensaje: 'El asiento ya fue vendido previamente' });

        asiento.vendido = 1;
        ventasMemoria.push({ ...venta, id: ventasMemoria.length + 1, codigoAsiento: asiento.codigoAsiento, fechaCompra: new Date() });
        res.json({ exito: true, mensaje: 'Venta registrada en memoria' });
    }
});

// 8. Informes
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
        } catch (e) {
            console.error(e);
        }
    }

    const ventasEvento = ventasMemoria.filter(v => v.evento_id === eventoId);
    const listaAsientos = asientosMemoria[eventoId] || [];

    const vendidas = ventasEvento.length;
    const recaudado = ventasEvento.reduce((acc, curr) => acc + Number(curr.monto_total), 0);
    const asistentes = listaAsientos.filter(a => a.vendido === 1 && a.asistio === 1).length;

    res.json({ vendidas, asistentes, recaudado });
});

// 9. Crear Usuario
app.post('/api/usuarios/crear', async (req, res) => {
    const nuevoUsr = req.body;

    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO usuarios (usuario, clave, tipo, identificacion) VALUES (?, ?, ?, ?)",
                args: [nuevoUsr.usuario, nuevoUsr.clave, nuevoUsr.tipo, nuevoUsr.identificacion]
            });
            return res.json({ exito: true, mensaje: 'Usuario guardado en base de datos' });
        } catch (e) {
            return res.json({ exito: false, mensaje: 'El nombre de usuario ya existe' });
        }
    } else {
        if (usuariosMemoria.some(u => u.usuario.toLowerCase() === nuevoUsr.usuario.toLowerCase())) {
            return res.json({ exito: false, mensaje: 'El nombre de usuario ya existe' });
        }
        nuevoUsr.id = usuariosMemoria.length + 1;
        usuariosMemoria.push(nuevoUsr);
        res.json({ exito: true, mensaje: 'Usuario registrado exitosamente (Memoria)' });
    }
});

// 10. Listar Usuarios
app.get('/api/super/usuarios', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT id, usuario, tipo, identificacion FROM usuarios");
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
        }
    }
    res.json(usuariosMemoria);
});

// 11. Revelar Clave
app.post('/api/super/revelar-clave', async (req, res) => {
    const { claveSuper, usuarioIdTarget } = req.body;

    if (db) {
        try {
            const superRes = await db.execute({ sql: "SELECT * FROM usuarios WHERE (tipo = 'super' OR tipo = 'admin') AND clave = ?", args: [claveSuper] });
            if (superRes.rows.length === 0) return res.status(403).json({ exito: false, mensaje: 'Clave de Superusuario incorrecta' });

            const targetRes = await db.execute({ sql: "SELECT clave FROM usuarios WHERE id = ?", args: [usuarioIdTarget] });
            if (targetRes.rows.length > 0) {
                return res.json({ exito: true, clave: targetRes.rows[0].clave });
            }
        } catch (e) {
            console.error(e);
        }
    } else {
        const superAdmin = usuariosMemoria.find(u => (u.tipo === 'super' || u.tipo === 'admin') && u.clave === claveSuper);
        if (!superAdmin) return res.status(403).json({ exito: false, mensaje: 'Clave de Superusuario incorrecta' });

        const target = usuariosMemoria.find(u => u.id === usuarioIdTarget);
        if (target) return res.json({ exito: true, clave: target.clave });
    }

    res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
});

// 12. Eliminar Usuario
app.delete('/api/super/usuarios/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);

    if (db) {
        try {
            await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [id] });
            return res.json({ exito: true, mensaje: 'Usuario eliminado' });
        } catch (e) {
            console.error(e);
        }
    }

    usuariosMemoria = usuariosMemoria.filter(u => u.id !== id);
    res.json({ exito: true, mensaje: 'Usuario eliminado (Memoria)' });
});

// Servir la página principal
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// INICIALIZACIÓN
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`===========================================`);
});
