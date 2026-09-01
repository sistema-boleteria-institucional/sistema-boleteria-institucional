const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'boleteria.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS eventos (
        id TEXT PRIMARY KEY, 
        nombre TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS reservas (
        idReserva TEXT PRIMARY KEY,
        eventoId TEXT,
        fecha TEXT,
        cliente TEXT,
        email TEXT,
        asiento TEXT,
        metodoPago TEXT,
        monto REAL,
        estado TEXT,
        ingresado INTEGER DEFAULT 0,
        fechaIngreso TEXT,
        qrTicket TEXT
    )`);
    db.run(`INSERT OR IGNORE INTO eventos (id, nombre) VALUES ('EV-101', 'Concierto de Gala 2026')`);
});

module.exports = db;
