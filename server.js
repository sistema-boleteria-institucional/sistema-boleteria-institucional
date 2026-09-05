require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar base de datos LibSQL / Turso
let db = null;
if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    db = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    });
}

// Estructuras en memoria como respaldo (Fallback)
const eventosMemoria = [];
const asientosMemoria = {}; // { idEvento: [ { id, numero, fila, columna, tipoZona, precio, estado, cliente, dni, telefono, metodoPago, transaccion, fechaVenta, pagado, cupon, descuento } ] }
const cuponesMemoria = {};  // { idEvento: [ { codigo, porcentaje, maxUsos, usosActuales } ] }

async function initDB() {
    if (!db) return;
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS eventos (
                id TEXT PRIMARY KEY,
                nombre TEXT,
                fecha TEXT,
                hora TEXT,
                precioGeneral REAL,
                precioGradas REAL
            )
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS asientos (
                id TEXT PRIMARY KEY,
                evento_id TEXT,
                numero INTEGER,
                fila INTEGER,
                columna INTEGER,
                tipoZona TEXT,
                precio REAL,
                estado TEXT,
                cliente TEXT,
                dni TEXT,
                telefono TEXT,
                metodoPago TEXT,
                transaccion TEXT,
                fechaVenta TEXT,
                pagado INTEGER,
                cupon TEXT,
                descuento REAL,
                vendido INTEGER
            )
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS cupones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id TEXT,
                codigo TEXT,
                porcentaje REAL,
                maxUsos INTEGER,
                usosActuales INTEGER
            )
        `);
    } catch (e) {
        console.error('Error al inicializar la base de datos:', e);
    }
}
initDB();

// API: Obtener eventos
app.get('/api/eventos', async (req, res) => {
    if (db) {
        try {
            const result = await db.execute("SELECT * FROM eventos");
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
            return res.status(500).json({ mensaje: 'Error al obtener eventos de DB' });
        }
    }
    res.json(eventosMemoria);
});

// API: Crear evento
app.post('/api/eventos', async (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, cantGen, precioGradas, cantGradas } = req.body;

    if (!id || !nombre || !fecha || !hora) {
        return res.status(400).json({ exito: false, mensaje: 'Faltan campos obligatorios' });
    }

    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO eventos (id, nombre, fecha, hora, precioGeneral, precioGradas) VALUES (?, ?, ?, ?, ?, ?)",
                args: [id, nombre, fecha, hora, precioGeneral, precioGradas]
            });

            // Generar asientos
            const numGen = Math.min(parseInt(cantGen) || 112, 112);
            for (let i = 1; i <= numGen; i++) {
                const fila = Math.ceil(i / 14);
                const col = ((i - 1) % 14) + 1;
                const asid = `${id}-G-${i}`;
                await db.execute({
                    sql: "INSERT INTO asientos (id, evento_id, numero, fila, columna, tipoZona, precio, estado, pagado, vendido) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
                    args: [asid, id, i, fila, col, 'General', precioGeneral, 'libre']
                });
            }

            const numGrada = Math.min(parseInt(cantGradas) || 24, 24);
            for (let i = 1; i <= numGrada; i++) {
                const fila = Math.ceil(i / 12);
                const col = ((i - 1) % 12) + 1;
                const asid = `${id}-GR-${i}`;
                await db.execute({
                    sql: "INSERT INTO asientos (id, evento_id, numero, fila, columna, tipoZona, precio, estado, pagado, vendido) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
                    args: [asid, id, i, fila, col, 'Grada', precioGradas, 'libre']
                });
            }

            return res.json({ exito: true, mensaje: 'Evento creado correctamente en DB' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al crear evento' });
        }
    } else {
        eventosMemoria.push({ id, nombre, fecha, hora, precioGeneral, precioGradas });
        asientosMemoria[id] = [];

        const numGen = Math.min(parseInt(cantGen) || 112, 112);
        for (let i = 1; i <= numGen; i++) {
            const fila = Math.ceil(i / 14);
            const col = ((i - 1) % 14) + 1;
            asientosMemoria[id].push({
                id: `${id}-G-${i}`,
                numero: i,
                fila,
                columna: col,
                tipoZona: 'General',
                precio: precioGeneral,
                estado: 'libre',
                pagado: 0,
                vendido: 0
            });
        }

        const numGrada = Math.min(parseInt(cantGradas) || 24, 24);
        for (let i = 1; i <= numGrada; i++) {
            const fila = Math.ceil(i / 12);
            const col = ((i - 1) % 12) + 1;
            asientosMemoria[id].push({
                id: `${id}-GR-${i}`,
                numero: i,
                fila,
                columna: col,
                tipoZona: 'Grada',
                precio: precioGradas,
                estado: 'libre',
                pagado: 0,
                vendido: 0
            });
        }

        return res.json({ exito: true, mensaje: 'Evento creado en Memoria' });
    }
});

// NUEVO: Modificar Evento Existente
app.put('/api/eventos/modificar', async (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, precioGradas } = req.body;

    if (!id || !nombre || !fecha || !hora) {
        return res.status(400).json({ exito: false, mensaje: 'Todos los campos obligatorios deben ser proporcionados.' });
    }

    if (db) {
        try {
            await db.execute({
                sql: "UPDATE eventos SET nombre = ?, fecha = ?, hora = ?, precioGeneral = ?, precioGradas = ? WHERE id = ?",
                args: [nombre, fecha, hora, precioGeneral, precioGradas, id]
            });

            await db.execute({
                sql: "UPDATE asientos SET precio = ? WHERE evento_id = ? AND tipoZona = 'General' AND vendido = 0",
                args: [precioGeneral, id]
            });
            await db.execute({
                sql: "UPDATE asientos SET precio = ? WHERE evento_id = ? AND tipoZona = 'Grada' AND vendido = 0",
                args: [precioGradas, id]
            });

            return res.json({ exito: true, mensaje: 'Evento modificado correctamente' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al modificar el evento' });
        }
    } else {
        const ev = eventosMemoria.find(e => e.id === id);
        if (!ev) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado' });

        ev.nombre = nombre;
        ev.fecha = fecha;
        ev.hora = hora;
        ev.precioGeneral = precioGeneral;
        ev.precioGradas = precioGradas;

        const lista = asientosMemoria[id] || [];
        lista.forEach(a => {
            if (a.vendido === 0) {
                if (a.tipoZona === 'General') a.precio = precioGeneral;
                if (a.tipoZona === 'Grada') a.precio = precioGradas;
            }
        });

        return res.json({ exito: true, mensaje: 'Evento modificado correctamente (Memoria)' });
    }
});

// API: Obtener asientos por evento
app.get('/api/asientos/:eventoId', async (req, res) => {
    const { eventoId } = req.params;
    if (db) {
        try {
            const result = await db.execute({
                sql: "SELECT * FROM asientos WHERE evento_id = ?",
                args: [eventoId]
            });
            return res.json(result.rows);
        } catch (e) {
            console.error(e);
            return res.status(500).json({ mensaje: 'Error al obtener asientos' });
        }
    }
    res.json(asientosMemoria[eventoId] || []);
});

// API: Procesar reserva o venta de asiento
app.post('/api/asientos/reservar', async (req, res) => {
    const { eventoId, asientoId, cliente, dni, telefono, metodoPago, transaccion, pagado, cupon, descuento } = req.body;

    const fechaVenta = new Date().toISOString().split('T')[0];

    if (db) {
        try {
            await db.execute({
                sql: `UPDATE asientos SET 
                    estado = 'ocupado', 
                    cliente = ?, 
                    dni = ?, 
                    telefono = ?, 
                    metodoPago = ?, 
                    transaccion = ?, 
                    fechaVenta = ?, 
                    pagado = ?, 
                    cupon = ?, 
                    descuento = ?,
                    vendido = 1
                    WHERE id = ? AND evento_id = ?`,
                args: [cliente, dni, telefono, metodoPago, transaccion, fechaVenta, pagado ? 1 : 0, cupon || '', descuento || 0, asientoId, eventoId]
            });
            return res.json({ exito: true, mensaje: 'Asiento actualizado correctamente' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al procesar reserva' });
        }
    } else {
        const lista = asientosMemoria[eventoId] || [];
        const asiento = lista.find(a => a.id === asientoId);
        if (asiento) {
            asiento.estado = 'ocupado';
            asiento.cliente = cliente;
            asiento.dni = dni;
            asiento.telefono = telefono;
            asiento.metodoPago = metodoPago;
            asiento.transaccion = transaccion;
            asiento.fechaVenta = fechaVenta;
            asiento.pagado = pagado ? 1 : 0;
            asiento.cupon = cupon || '';
            asiento.descuento = descuento || 0;
            asiento.vendido = 1;
            return res.json({ exito: true, mensaje: 'Asiento actualizado en memoria' });
        }
        return res.status(404).json({ exito: false, mensaje: 'Asiento no encontrado' });
    }
});

// API: Liberar asiento
app.post('/api/asientos/liberar', async (req, res) => {
    const { eventoId, asientoId } = req.body;
    if (db) {
        try {
            await db.execute({
                sql: `UPDATE asientos SET 
                    estado = 'libre', cliente = NULL, dni = NULL, telefono = NULL, 
                    metodoPago = NULL, transaccion = NULL, fechaVenta = NULL, 
                    pagado = 0, cupon = NULL, descuento = 0, vendido = 0
                    WHERE id = ? AND evento_id = ?`,
                args: [asientoId, eventoId]
            });
            return res.json({ exito: true, mensaje: 'Asiento liberado correctamente' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al liberar asiento' });
        }
    } else {
        const lista = asientosMemoria[eventoId] || [];
        const asiento = lista.find(a => a.id === asientoId);
        if (asiento) {
            asiento.estado = 'libre';
            asiento.cliente = null;
            asiento.dni = null;
            asiento.telefono = null;
            asiento.metodoPago = null;
            asiento.transaccion = null;
            asiento.fechaVenta = null;
            asiento.pagado = 0;
            asiento.cupon = null;
            asiento.descuento = 0;
            asiento.vendido = 0;
            return res.json({ exito: true, mensaje: 'Asiento liberado en memoria' });
        }
        return res.status(404).json({ exito: false, mensaje: 'Asiento no encontrado' });
    }
});

// API: Gestión de Cupones
app.post('/api/cupones', async (req, res) => {
    const { eventoId, codigo, porcentaje, maxUsos } = req.body;
    if (db) {
        try {
            await db.execute({
                sql: "INSERT INTO cupones (evento_id, codigo, porcentaje, maxUsos, usosActuales) VALUES (?, ?, ?, ?, 0)",
                args: [eventoId, codigo.toUpperCase(), porcentaje, maxUsos]
            });
            return res.json({ exito: true, mensaje: 'Cupón creado' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ exito: false, mensaje: 'Error al crear cupón' });
        }
    } else {
        if (!cuponesMemoria[eventoId]) cuponesMemoria[eventoId] = [];
        cuponesMemoria[eventoId].push({
            codigo: codigo.toUpperCase(),
            porcentaje: parseFloat(porcentaje),
            maxUsos: parseInt(maxUsos),
            usosActuales: 0
        });
        return res.json({ exito: true, mensaje: 'Cupón creado en memoria' });
    }
});

app.post('/api/cupones/validar', async (req, res) => {
    const { eventoId, codigo } = req.body;
    const codUpper = (codigo || '').toUpperCase();

    if (db) {
        try {
            const result = await db.execute({
                sql: "SELECT * FROM cupones WHERE evento_id = ? AND codigo = ?",
                args: [eventoId, codUpper]
            });
            if (result.rows.length > 0) {
                const cup = result.rows[0];
                if (cup.usosActuales < cup.maxUsos) {
                    return res.json({ valido: true, porcentaje: cup.porcentaje });
                } else {
                    return res.json({ valido: false, mensaje: 'Cupón agotado' });
                }
            }
            return res.json({ valido: false, mensaje: 'Cupón no válido' });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ valido: false, mensaje: 'Error al validar cupón' });
        }
    } else {
        const lista = cuponesMemoria[eventoId] || [];
        const cup = lista.find(c => c.codigo === codUpper);
        if (cup) {
            if (cup.usosActuales < cup.maxUsos) {
                return res.json({ valido: true, porcentaje: cup.porcentaje });
            } else {
                return res.json({ valido: false, mensaje: 'Cupón agotado' });
            }
        }
        return res.json({ valido: false, mensaje: 'Cupón no válido' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});

