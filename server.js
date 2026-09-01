const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());

// 1. Servir archivos estáticos directamente desde la RAÍZ (ya no desde /public)
app.use(express.static(__dirname));

// 2. Ruta principal para cargar index.html desde la raíz
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint Consultar Historial Dashboard
app.get('/api/eventos/:id/historial', (req, res) => {
    const eventoId = req.params.id;
    db.get(`SELECT * FROM eventos WHERE id = ?`, [eventoId], (err, evento) => {
        if (!evento) return res.status(404).json({ mensaje: 'Evento no encontrado' });
        db.all(`SELECT * FROM reservas WHERE eventoId = ?`, [eventoId], (err, filas) => {
            const recaudado = filas.filter(v => v.estado === 'Completado').reduce((sum, v) => sum + v.monto, 0);
            res.json({ nombre: evento.nombre, recaudado, totalVentas: filas.length, historialVentas: filas });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
