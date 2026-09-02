const express = require('express');
const { createClient } = require('@libsql/client/http'); // <--- Usar cliente HTTP directo

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Conexión directa HTTPS a Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Inicialización de esquema y datos por defecto
async function initDB() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT UNIQUE,
            identificacion TEXT,
            clave TEXT,
            tipo TEXT
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS eventos (
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

        await db.execute(`CREATE TABLE IF NOT EXISTS asientos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evento_id TEXT,
            codigoAsiento TEXT,
            tipoZona TEXT,
            precio REAL,
            vendido INTEGER DEFAULT 0,
            habilitado INTEGER DEFAULT 1,
            FOREIGN KEY(evento_id) REFERENCES eventos(id)
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS ventas (
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

        await db.execute(`CREATE TABLE IF NOT EXISTS cupones (
            codigo TEXT PRIMARY KEY,
            porcentaje REAL
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT
        )`);

        // Superusuario predeterminado
        await db.execute({
            sql: `INSERT OR IGNORE INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)`,
            args: ['superadmin', 'SU-001', 'admin1234', 'super']
        });

        console.log("Base de datos inicializada correctamente en Turso.");
    } catch (error) {
        console.error("Error al inicializar la base de datos:", error);
    }
}

initDB();

// --- RUTAS DE AUTENTICACIÓN Y USUARIOS ---

app.post('/api/login', async (req, res) => {
    try {
        const { usuario, clave } = req.body;
        const result = await db.execute({
            sql: "SELECT * FROM usuarios WHERE usuario = ? AND clave = ?",
            args: [usuario, clave]
        });
        
        const user = result.rows[0];
        if (!user) {
            return res.json({ exito: false, mensaje: "Credenciales incorrectas" });
        }
        res.json({ exito: true, usuario: user.usuario, tipo: user.tipo, id: user.id });
    } catch (err) {
        console.error("Error en /api/login:", err);
        res.status(500).json({ exito: false, mensaje: "Error interno del servidor" });
    }
});

app.get('/api/super/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, usuario, identificacion, tipo FROM usuarios");
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener usuarios:", err);
        res.status(500).json([]);
    }
});

app.post('/api/usuarios/crear', async (req, res) => {
    const { usuario, identificacion, clave, tipo } = req.body;
    try {
        await db.execute({
            sql: "INSERT INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)",
            args: [usuario, identificacion, clave, tipo]
        });
        res.json({ exito: true, mensaje: "Usuario registrado con éxito" });
    } catch (err) {
        console.error("Error al crear usuario:", err);
        res.json({ exito: false, mensaje: "El usuario ya existe o hubo un error" });
    }
});

app.delete('/api/super/usuarios/:id', async (req, res) => {
    try {
        await db.execute({
            sql: "DELETE FROM usuarios WHERE id = ?",
            args: [req.params.id]
        });
        res.json({ exito: true, mensaje: "Usuario eliminado" });
    } catch (err) {
        console.error("Error al eliminar usuario:", err);
        res.json({ exito: false, mensaje: "Error al eliminar usuario" });
    }
});

// --- RUTAS DE EVENTOS Y ASIENTOS ---

app.get('/api/eventos', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM eventos ORDER BY fecha DESC");
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener eventos:", err);
        res.status(500).json([]);
    }
});

app.post('/api/eventos/crear', async (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada } = req.body;
    try {
        await db.execute({
            sql: "INSERT INTO eventos (id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada]
        });

        const filas = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        let contador = 0;
        for (const f of filas) {
            for (let i = 1; i <= 16; i++) {
                if (contador < dispGen) {
                    await db.execute({
                        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'General', ?)",
                        args: [id, `GEN-${f}${i}`, precioGeneral]
                    });
                    contador++;
                }
            }
        }
        res.json({ exito: true, mensaje: "Evento creado exitosamente" });
    } catch (err) {
        console.error("Error al crear evento:", err);
        res.json({ exito: false, mensaje: "Error al crear el evento" });
    }
});

app.get('/api/eventos/:id/asientos', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM asientos WHERE evento_id = ?",
            args: [req.params.id]
        });
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener asientos:", err);
        res.status(500).json([]);
    }
});

// --- RUTAS DE VENTAS ---

app.post('/api/ventas/procesar', async (req, res) => {
    const { evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total } = req.body;
    try {
        await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [asiento_id] });
        await db.execute({
            sql: "INSERT INTO ventas (evento_id, asiento_id, nombre_cliente, apellido_cliente, contacto, email, metodo_pago, monto_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total]
        });
        res.json({ exito: true, mensaje: "Venta registrada exitosamente" });
    } catch (err) {
        console.error("Error al procesar la venta:", err);
        res.json({ exito: false, mensaje: "Error al procesar la venta" });
    }
});

// Puerto dinámico de Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ejecutándose en puerto ${PORT}`));
