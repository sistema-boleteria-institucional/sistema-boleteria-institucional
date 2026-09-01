const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'boleteria.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 1. Tabla de Operarios/Vendedores
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'operario'
    )`);

    // Insertar operario por defecto
    db.run(`INSERT OR IGNORE INTO usuarios (id, nombre, rol) VALUES (1, 'Operario Caja 1', 'operario')`);

    // 2. Tabla de Eventos (Fecha y Hora)
    db.run(`CREATE TABLE IF NOT EXISTS eventos (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL
    )`);

    // 3. Tabla de Asientos del Evento
    db.run(`CREATE TABLE IF NOT EXISTS asientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eventoId TEXT,
        codigoAsiento TEXT,
        tipoZona TEXT, -- 'General' o 'Grada'
        precio REAL,
        habilitado INTEGER DEFAULT 1, -- 1: Disponible para venta, 0: Bloqueado
        vendido INTEGER DEFAULT 0,    -- 1: Vendido, 0: Libres
        FOREIGN KEY(eventoId) REFERENCES eventos(id)
    )`);

    // 4. Tabla de Reservas / Ventas Detalladas
    db.run(`CREATE TABLE IF NOT EXISTS reservas (
        idReserva TEXT PRIMARY KEY,
        eventoId TEXT,
        asientoCodigo TEXT,
        fechaVenta TEXT,
        horaVenta TEXT,
        metodoPago TEXT, -- 'mercadopago' o 'efectivo'
        monto REAL,
        clienteNombre TEXT NOT NULL,
        clienteApellido TEXT NOT NULL,
        clienteContacto TEXT NOT NULL,
        clienteEmail TEXT, -- Opcional
        operarioId INTEGER,
        qrTicket TEXT,
        ingresado INTEGER DEFAULT 0,
        fechaIngreso TEXT,
        FOREIGN KEY(eventoId) REFERENCES eventos(id),
        FOREIGN KEY(operarioId) REFERENCES usuarios(id)
    )`);
});

module.exports = db;
