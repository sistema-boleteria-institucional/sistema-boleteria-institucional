const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./boleteria.db');

db.serialize(() => {
    // 1. Tabla de Usuarios
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        identificacion TEXT UNIQUE,
        clave TEXT,
        tipo TEXT -- 'adm' o 'vendedor'
    )`);

    // Insertar Superusuario por defecto si no existe
    const stmt = db.prepare(`INSERT OR IGNORE INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)`);
    stmt.run('gogalarza', 'gonzalog2019', 'Limon2.0grana', 'adm');
    stmt.finalize();

    // 2. Tabla de Eventos
    db.run(`CREATE TABLE IF NOT EXISTS eventos (
        id TEXT PRIMARY KEY,
        nombre TEXT,
        fecha TEXT,
        hora TEXT
    )`);

    // 3. Tabla de Asientos
    db.run(`CREATE TABLE IF NOT EXISTS asientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eventoId TEXT,
        codigoAsiento TEXT,
        tipoZona TEXT,
        precio REAL,
        habilitado INTEGER,
        vendido INTEGER
    )`);

    // 4. Tabla de Reservas
    db.run(`CREATE TABLE IF NOT EXISTS reservas (
        idReserva TEXT PRIMARY KEY,
        eventoId TEXT,
        asientoCodigo TEXT,
        fechaVenta TEXT,
        horaVenta TEXT,
        metodoPago TEXT,
        monto REAL,
        clienteNombre TEXT,
        clienteApellido TEXT,
        clienteContacto TEXT,
        clienteEmail TEXT,
        operarioId TEXT,
        qrTicket TEXT
    )`);
});

module.exports = db;
