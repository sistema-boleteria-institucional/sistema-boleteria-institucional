const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// OBTENER LISTA DE TODOS LOS EVENTOS
app.get('/api/eventos', (req, res) => {
    db.all(`SELECT * FROM eventos`, [], (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(filas);
    });
});

// ==========================================
// 1. CREAR EVENTO Y CONFIGURAR ASIENTOS Y PRECIOS
// ==========================================
app.post('/api/eventos/crear', (req, res) => {
    const { id, nombre, fecha, hora, precioGeneral, precioGradas, totalDisponiblesGeneral, totalDisponiblesGradas } = req.body;

    db.run(`INSERT INTO eventos (id, nombre, fecha, hora) VALUES (?, ?, ?, ?)`, [id, nombre, fecha, hora], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        const stmt = db.prepare(`INSERT INTO asientos (eventoId, codigoAsiento, tipoZona, precio, habilitado, vendido) VALUES (?, ?, ?, ?, ?, 0)`);

        // Generar 7 Filas (A-G) de 16 Asientos (General) = 112 asientos
        const filasGeneral = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        let contadorGeneral = 0;
        filasGeneral.forEach(fila => {
            for (let i = 1; i <= 16; i++) {
                contadorGeneral++;
                const codigo = `GEN-${fila}${i}`;
                const habilitado = contadorGeneral <= (totalDisponiblesGeneral || 112) ? 1 : 0;
                stmt.run(id, codigo, 'General', precioGeneral, habilitado);
            }
        });

        // Generar 2 Gradas de 3 Filas x 4 Asientos (Especial) = 24 asientos
        let contadorGrada = 0;
        ['G1', 'G2'].forEach(grada => {
            ['F1', 'F2', 'F3'].forEach(fila => {
                for (let i = 1; i <= 4; i++) {
                    contadorGrada++;
                    const codigo = `${grada}-${fila}-${i}`;
                    const habilitado = contadorGrada <= (totalDisponiblesGradas || 24) ? 1 : 0;
                    stmt.run(id, codigo, 'Grada', precioGradas, habilitado);
                }
            });
        });

        stmt.finalize();
        res.json({ exito: true, mensaje: 'Evento y capacidad de asientos configurados correctamente.' });
    });
});

// ==========================================
// 2. REGISTRAR VENTA DE ENTRADA (REGISTRO COMPLETO)
// ==========================================
app.post('/api/ventas/registrar', (req, res) => {
    const { 
        eventoId, 
        codigoAsiento, 
        metodoPago, 
        clienteNombre, 
        clienteApellido, 
        clienteContacto, 
        clienteEmail, 
        operarioId 
    } = req.body;

    // Verificar disponibilidad del asiento
    db.get(`SELECT * FROM asientos WHERE eventoId = ? AND codigoAsiento = ? AND habilitado = 1 AND vendido = 0`, 
    [eventoId, codigoAsiento], (err, asiento) => {
        if (err || !asiento) return res.status(400).json({ exito: false, mensaje: 'El asiento no está disponible o no está habilitado.' });

        const idReserva = `RES-${Date.now()}`;
        const fechaActual = new Date().toLocaleDateString();
        const horaActual = new Date().toLocaleTimeString();
        const payloadQR = JSON.stringify({ reservaId: idReserva, eventoId, asiento: codigoAsiento });

        const sqlReserva = `INSERT INTO reservas 
            (idReserva, eventoId, asientoCodigo, fechaVenta, horaVenta, metodoPago, monto, clienteNombre, clienteApellido, clienteContacto, clienteEmail, operarioId, qrTicket)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(sqlReserva, [
            idReserva, eventoId, codigoAsiento, fechaActual, horaActual, metodoPago, asiento.precio,
            clienteNombre, clienteApellido, clienteContacto, clienteEmail || null, operarioId, payloadQR
        ], function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // Marcar asiento como vendido
            db.run(`UPDATE asientos SET vendido = 1 WHERE id = ?`, [asiento.id], (err) => {
                res.json({ 
                    exito: true, 
                    mensaje: 'Venta registrada con éxito', 
                    idReserva, 
                    monto: asiento.precio,
                    operarioId 
                });
            });
        });
    });
});

// ==========================================
// 3. OBTENER MAPA Y ESTADO DE ASIENTOS DE UN EVENTO
// ==========================================
app.get('/api/eventos/:id/asientos', (req, res) => {
    db.all(`SELECT * FROM asientos WHERE eventoId = ?`, [req.params.id], (err, filas) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(filas);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
