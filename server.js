const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());

// Sirve archivos estáticos desde la raíz del proyecto
app.use(express.static(__dirname));

// Inicialización de la Base de Datos SQLite
const db = new sqlite3.Database('./boleteria.db', (err) => {
    if (err) console.error("Error al conectar DB:", err.message);
    else console.log("Conectado a la base de datos SQLite.");
});

// Estructura de Tablas
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        identificacion TEXT,
        clave TEXT,
        tipo TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS eventos (
        id TEXT PRIMARY KEY,
        nombre TEXT,
        fecha TEXT,
        hora TEXT,
        precioGeneral REAL,
        precioGradas REAL,
        dispGen INTEGER,
        dispGrada INTEGER,
        informe_enviado INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS asientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evento_id TEXT,
        codigoAsiento TEXT,
        tipoZona TEXT,
        precio REAL,
        vendido INTEGER DEFAULT 0,
        habilitado INTEGER DEFAULT 1,
        FOREIGN KEY(evento_id) REFERENCES eventos(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evento_id TEXT,
        asiento_id INTEGER,
        nombre_cliente TEXT,
        apellido_cliente TEXT,
        contacto TEXT,
        email TEXT,
        metodo_pago TEXT,
        monto_total REAL,
        asistio INTEGER DEFAULT 0,
        fecha_venta DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asiento_id) REFERENCES asientos(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cupones (
        codigo TEXT PRIMARY KEY,
        porcentaje REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT
    )`);

    // Superusuario semilla por defecto
    db.run(`INSERT OR IGNORE INTO usuarios (usuario, identificacion, clave, tipo) 
            VALUES ('superadmin', 'SU-001', 'admin1234', 'super')`);
});

let usuarioSesionActiva = null;

// --- AUTENTICACIÓN Y USUARIOS ---
app.post('/api/login', (req, res) => {
    const { usuario, clave } = req.body;
    db.get("SELECT * FROM usuarios WHERE usuario = ? AND clave = ?", [usuario, clave], (err, user) => {
        if (err || !user) return res.json({ exito: false, mensaje: "Credenciales incorrectas" });
        usuarioSesionActiva = user;
        res.json({ exito: true, usuario: user.usuario, tipo: user.tipo, id: user.id });
    });
});

app.get('/api/super/usuarios', (req, res) => {
    db.all("SELECT id, usuario, identificacion, tipo FROM usuarios", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/super/revelar-clave', (req, res) => {
    const { claveSuper, usuarioIdTarget } = req.body;
    if (!usuarioSesionActiva || usuarioSesionActiva.tipo !== 'super') {
        return res.status(403).json({ exito: false, mensaje: "Acceso no autorizado" });
    }
    
    db.get("SELECT clave FROM usuarios WHERE id = ?", [usuarioSesionActiva.id], (err, superUser) => {
        if (err || !superUser || claveSuper !== superUser.clave) {
            return res.json({ exito: false, mensaje: "Clave de superusuario incorrecta" });
        }
        db.get("SELECT clave FROM usuarios WHERE id = ?", [usuarioIdTarget], (err, target) => {
            if (err || !target) return res.json({ exito: false, mensaje: "Usuario no encontrado" });
            res.json({ exito: true, clave: target.clave });
        });
    });
});

app.post('/api/usuarios/crear', (req, res) => {
    const { usuario, identificacion, clave, tipo } = req.body;
    db.run("INSERT INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)",
        [usuario, identificacion, clave, tipo], (err) => {
            if (err) return res.json({ exito: false, mensaje: "El usuario ya existe o hubo un error al registrar" });
            res.json({ exito: true, mensaje: "Usuario registrado con éxito" });
        });
});

app.delete('/api/super/usuarios/:id', (req, res) => {
    db.run("DELETE FROM usuarios WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true, mensaje: "Usuario eliminado" });
    });
});

// --- EVENTOS Y MAPA DE ASIENTOS ---
app.get('/api/eventos', (req, res) => {
    db.all("SELECT * FROM eventos ORDER BY fecha DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/eventos/crear', (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada } = req.body;
    
    db.run("INSERT INTO eventos (id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada], function(err) {
            if (err) return res.json({ exito: false, mensaje: "El ID de evento ya existe o es inválido" });

            const filas = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
            db.serialize(() => {
                let contador = 0;
                filas.forEach(f => {
                    for (let i = 1; i <= 16; i++) {
                        if (contador < dispGen) {
                            db.run("INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'General', ?)",
                                [id, `GEN-${f}${i}`, precioGeneral]);
                            contador++;
                        }
                    }
                });
                const limiteG1 = Math.min(12, Math.floor(dispGrada / 2));
                const limiteG2 = Math.min(12, Math.ceil(dispGrada / 2));
                
                for (let g1 = 1; g1 <= limiteG1; g1++) {
                    db.run("INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'Grada', ?)",
                        [id, `G1-${g1}`, precioGradas]);
                }
                for (let g2 = 1; g2 <= limiteG2; g2++) {
                    db.run("INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'Grada', ?)",
                        [id, `G2-${g2}`, precioGradas]);
                }
            });
            res.json({ exito: true, mensaje: "Evento y mapa creados exitosamente" });
        });
});

app.get('/api/eventos/:id/asientos', (req, res) => {
    db.all("SELECT * FROM asientos WHERE evento_id = ?", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- VENTAS, CUPONES Y CAMBIOS ---
app.post('/api/cupones/validar', (req, res) => {
    const { codigo } = req.body;
    db.get("SELECT porcentaje FROM cupones WHERE codigo = ?", [codigo], (err, row) => {
        if (err || !row) return res.json({ valido: false, mensaje: "Cupón inválido" });
        res.json({ valido: true, porcentaje: row.porcentaje });
    });
});

app.post('/api/cupones/crear', (req, res) => {
    const { codigo, porcentaje } = req.body;
    db.run("INSERT INTO cupones (codigo, porcentaje) VALUES (?, ?)", [codigo, porcentaje], (err) => {
        if (err) return res.json({ exito: false, mensaje: "El cupón ya existe" });
        res.json({ exito: true, mensaje: "Cupón registrado correctamente" });
    });
});

app.post('/api/ventas/procesar', (req, res) => {
    const { evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total } = req.body;
    
    db.serialize(() => {
        db.run("UPDATE asientos SET vendido = 1 WHERE id = ?", [asiento_id]);
        db.run("INSERT INTO ventas (evento_id, asiento_id, nombre_cliente, apellido_cliente, contacto, email, metodo_pago, monto_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total], function(err) {
                if (err) return res.json({ exito: false, mensaje: "Error al registrar venta" });
                res.json({ exito: true, ventaId: this.lastID, mensaje: "Venta registrada con éxito" });
            });
    });
});

app.post('/api/ventas/cancelar', (req, res) => {
    const { ventaId, asientoId } = req.body;
    db.serialize(() => {
        db.run("UPDATE asientos SET vendido = 0 WHERE id = ?", [asientoId]);
        db.run("DELETE FROM ventas WHERE id = ?", [ventaId], (err) => {
            if (err) return res.json({ exito: false, mensaje: "Error al cancelar venta" });
            res.json({ exito: true, mensaje: "Venta cancelada y asiento liberado" });
        });
    });
});

app.post('/api/ventas/reubicar', (req, res) => {
    const { ventaId, nuevoAsientoId, viejoAsientoId } = req.body;
    db.serialize(() => {
        db.run("UPDATE asientos SET vendido = 0 WHERE id = ?", [viejoAsientoId]);
        db.run("UPDATE asientos SET vendido = 1 WHERE id = ?", [nuevoAsientoId]);
        db.run("UPDATE ventas SET asiento_id = ? WHERE id = ?", [nuevoAsientoId, ventaId], (err) => {
            if (err) return res.json({ exito: false, mensaje: "Error al reubicar asiento" });
            res.json({ exito: true, mensaje: "Asiento reubicado con éxito" });
        });
    });
});

// --- INFORMES Y CONFIGURACIÓN ---
app.get('/api/informe/:eventoId', (req, res) => {
    db.get(`
        SELECT 
            COUNT(v.id) as vendidas,
            SUM(CASE WHEN v.asistio = 1 THEN 1 ELSE 0 END) as asistentes,
            SUM(v.monto_total) as recaudado
        FROM ventas v WHERE v.evento_id = ?`, [req.params.eventoId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || { vendidas: 0, asistentes: 0, recaudado: 0 });
        });
});

app.post('/api/config/email-informe', (req, res) => {
    const { email } = req.body;
    db.run("INSERT OR REPLACE INTO configuracion (clave, valor) VALUES ('email_informe', ?)", [email], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exito: true, mensaje: "Email para informes configurado con éxito" });
    });
});

// Tarea programada cada hora para verificar informes pasadas las 12 horas
cron.schedule('0 * * * *', () => {
    const ahora = new Date();
    db.all("SELECT * FROM eventos WHERE informe_enviado = 0", [], (err, eventos) => {
        if (!eventos) return;
        eventos.forEach(ev => {
            const fechaEvento = new Date(`${ev.fecha}T${ev.hora}`);
            const difHoras = (ahora - fechaEvento) / (1000 * 60 * 60);
            if (difHoras >= 12) {
                db.run("UPDATE eventos SET informe_enviado = 1 WHERE id = ?", [ev.id]);
                console.log(`Informe procesado automáticamente para el evento ID: ${ev.id}`);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Boletería iniciado en puerto ${PORT}`));
