const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();

// Middlewares para procesar JSON y archivos estáticos
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

// ==========================================
// AUTENTICACIÓN Y GESTIÓN DE USUARIOS
// ==========================================

// Login de usuarios
app.post('/api/login', (req, res) => {
    const { usuario, clave } = req.body;
    db.get(`SELECT * FROM usuarios WHERE usuario = ? AND clave = ?`, [usuario, clave], (err, row) => {
        if (err) return res.status(500).json({ exito: false, mensaje: err.message });
        if (!row) return res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
        
        res.json({
            exito: true,
            usuario: row.usuario,
            identificacion: row.identificacion,
            tipo: row.tipo
        });
    });
});

// Crear nuevo usuario (Solo Administradores)
app.post('/api/usuarios/crear', (req, res) => {
    const { usuario, identificacion, clave, tipo } = req.body;

    if (!usuario || !identificacion || !clave || !tipo) {
        return res.status(400).json({ exito: false, mensaje: 'Todos los campos son obligatorios' });
    }

    const sql = `INSERT INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)`;
    db.run(sql, [usuario, identificacion, clave, tipo], function(err) {
        if (err) {
            return res.status(400).json({ exito: false, mensaje: 'El usuario o identificación ya existen.' });
        }
        res.json({ exito: true, mensaje: 'Usuario creado exitosamente con ID: ' + this.lastID });
    });
});

// Obtener lista de usuarios
app.get('/api/usuarios', (req, res) => {
    db.all(`SELECT id, usuario, identificacion, tipo FROM usuarios`, [], (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(filas || []);
    });
});

// Ruta principal para servir el frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// GESTIÓN DE EVENTOS Y ASIENTOS
// ==========================================

// Crear Evento con sus Asientos
app.post('/api/eventos/crear', (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, precioGradas, dispGen, dispGrada } = req.body;

    const sqlEvento = `INSERT INTO eventos (id, nombre, fecha, hora) VALUES (?, ?, ?, ?)`;
    db.run(sqlEvento, [id, nombre, fecha, hora], function(err) {
        if (err) return res.status(400).json({ exito: false, mensaje: 'El ID del evento ya existe' });

        const stmt = db.prepare(`INSERT INTO asientos (eventoId, codigoAsiento, tipoZona, precio, habilitado, vendido) VALUES (?, ?, ?, ?, ?, 0)`);
        
        // Asientos General (7x16 = 112)
        const filasGen = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        let contGen = 0;
        filasGen.forEach(fila => {
            for (let i = 1; i <= 16; i++) {
                contGen++;
                stmt.run(id, `GEN-${fila}${i}`, 'General', precioGeneral, contGen <= dispGen ? 1 : 0);
            }
        });

        // Asientos Gradas (2x3x4 = 24)
        let contGrada = 0;
        ['G1', 'G2'].forEach(grada => {
            ['F1', 'F2', 'F3'].forEach(fila => {
                for (let i = 1; i <= 4; i++) {
                    contGrada++;
                    stmt.run(id, `${grada}-${fila}-${i}`, 'Grada', precioGradas, contGrada <= dispGrada ? 1 : 0);
                }
            });
        });

        stmt.finalize();
        res.json({ exito: true, mensaje: '¡Evento y mapa de asientos creados exitosamente!' });
    });
});

// Obtener Lista de Eventos
app.get('/api/eventos', (req, res) => {
    db.all(`SELECT * FROM eventos`, [], (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(filas || []);
    });
});

// Obtener Asientos de un Evento
app.get('/api/eventos/:id/asientos', (req, res) => {
    db.all(`SELECT * FROM asientos WHERE eventoId = ?`, [req.params.id], (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(filas || []);
    });
});
// Puerto dinámico asignado por Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
