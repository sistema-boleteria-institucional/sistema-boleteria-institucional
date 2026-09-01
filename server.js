// ==========================================
// AUTENTICACIÓN Y GESTIÓN DE USUARIOS
// ==========================================
const db = require('./database');
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});

