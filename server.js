const express = require('express');
const path = require('path');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const { generarQRConLogo } = require('./qrService');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mercado Pago Client Setup
const client = new MercadoPagoConfig({ accessToken: 'PROD_ACCESS_TOKEN_AQUI' });

// Base de Datos Simulada en Memoria
const eventosBD = {
    'EV-101': {
        nombre: 'Concierto de Gala 2026',
        historialVentas: [
            { idReserva: 'RES-101', fecha: '2026-08-26 10:15:20', cliente: 'Juan Pérez', email: 'juan@email.com', asiento: 'A-15', metodoPago: 'Efectivo', monto: 1500, estado: 'Completado', ingresado: true, fechaIngreso: '10:30:15' },
            { idReserva: 'RES-102', fecha: '2026-08-26 10:22:11', cliente: 'María Gómez', email: 'maria@email.com', asiento: 'A-16', metodoPago: 'Mercado Pago', monto: 1500, estado: 'Completado', ingresado: false, fechaIngreso: null },
            { idReserva: 'RES-103', fecha: '2026-08-26 11:05:40', cliente: 'Carlos Rodríguez', email: 'carlos@email.com', asiento: 'B-01', metodoPago: 'Mercado Pago', monto: 1500, estado: 'Completado', ingresado: false, fechaIngreso: null },
            { idReserva: 'RES-104', fecha: '2026-08-26 11:40:02', cliente: 'Ana Martínez', email: 'ana@email.com', asiento: 'B-02', metodoPago: 'Efectivo', monto: 1500, estado: 'Pendiente', ingresado: false, fechaIngreso: null }
        ]
    }
};

// 1. ENDPOINT: Crear Reserva y Procesar Pago (Efectivo / Mercado Pago)
app.post('/api/crear-reserva', async (req, res) => {
    const { eventoId, asientoId, metodoPago, cliente, monto } = req.body;
    const evento = eventosBD[eventoId];

    if (!evento) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado' });

    const idReserva = `RES-${Date.now()}`;
    const payloadQR = JSON.stringify({ reservaId: idReserva, eventoId, asientoId });

    // Generar QR Ticket con Logo Institucional
    const logoPath = path.join(__dirname, 'public', 'assets', 'logo.png');
    const qrDataURL = await generarQRConLogo(payloadQR, logoPath);

    const nuevaVenta = {
        idReserva,
        fecha: new Date().toLocaleString(),
        cliente: cliente.nombre,
        email: cliente.email,
        asiento: asientoId,
        metodoPago: metodoPago === 'efectivo' ? 'Efectivo' : 'Mercado Pago',
        monto: monto || 1500,
        estado: metodoPago === 'efectivo' ? 'Pendiente' : 'Completado',
        ingresado: false,
        fechaIngreso: null,
        qrTicket: qrDataURL
    };

    evento.historialVentas.push(nuevaVenta);

    if (metodoPago === 'efectivo') {
        return res.json({
            exito: true,
            mensaje: 'Reserva registrada. Por favor abona en boletería.',
            reserva: nuevaVenta
        });
    }

    if (metodoPago === 'mercadopago') {
        try {
            const preference = new Preference(client);
            const response = await preference.create({
                body: {
                    items: [{ id: asientoId, title: `Entrada ${evento.nombre} - ${asientoId}`, unit_price: nuevaVenta.monto, quantity: 1 }],
                    external_reference: idReserva,
                    auto_return: 'approved'
                }
            });

            return res.json({ exito: true, init_point: response.init_point, reserva: nuevaVenta });
        } catch (error) {
            return res.status(500).json({ exito: false, error: error.message });
        }
    }
});

// 2. ENDPOINT: Validar Acceso en Puerta (App Escáner)
app.post('/api/validar-qr', (req, res) => {
    const { reservaId, eventoId } = req.body;
    const evento = eventosBD[eventoId];

    if (!evento) return res.status(404).json({ valido: false, mensaje: 'Evento Inexistente' });

    const reserva = evento.historialVentas.find(v => v.idReserva === reservaId);

    if (!reserva) {
        return res.status(404).json({ valido: false, razon: 'Ticket Inválido', mensaje: 'Ticket no registrado en el sistema.' });
    }

    if (reserva.estado !== 'Completado') {
        return res.status(400).json({ valido: false, razon: 'Pago Pendiente', mensaje: 'El ticket aún no ha sido abonado en boletería.' });
    }

    if (reserva.ingresado) {
        return res.status(409).json({
            valido: false,
            razon: 'Ticket Ya Usado',
            mensaje: `ACCESO DENEGADO: Ticket utilizado previamente a las ${reserva.fechaIngreso}. Diríjase a boletería.`
        });
    }

    // Permitir acceso y registrar hora de ingreso
    reserva.ingresado = true;
    reserva.fechaIngreso = new Date().toLocaleTimeString();

    return res.json({
        valido: true,
        mensaje: 'ACCESO PERMITIDO',
        cliente: reserva.cliente,
        asiento: reserva.asiento
    });
});

// 3. ENDPOINT: Dashboard e Historial de Ventas
app.get('/api/eventos/:id/historial', (req, res) => {
    const evento = eventosBD[req.params.id];
    if (!evento) return res.status(404).json({ mensaje: 'Evento no encontrado' });

    const recaudado = evento.historialVentas
        .filter(v => v.estado === 'Completado')
        .reduce((sum, v) => sum + v.monto, 0);

    const asistenciaCount = evento.historialVentas.filter(v => v.ingresado).length;

    res.json({
        nombre: evento.nombre,
        recaudado,
        totalVentas: evento.historialVentas.length,
        asistencia: asistenciaCount,
        historialVentas: evento.historialVentas
    });
});

// 4. ENDPOINT: Exportar Excel
app.get('/api/eventos/:id/descargar-excel', async (req, res) => {
    const evento = eventosBD[req.params.id];
    if (!evento) return res.status(404).send('Evento no encontrado');

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Historial de Ventas');

    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `REPORTE CONSOLIDADO DE VENTAS - ${evento.nombre.toUpperCase()}`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFF' } };
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

    ws.addRow([]);
    ws.addRow(['ID Reserva', 'Fecha/Hora', 'Cliente', 'Email', 'Asiento', 'Método Pago', 'Monto ($)', 'Estado Pago']);
    const headerRow = ws.getRow(3);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2F5597' } };

    evento.historialVentas.forEach(v => {
        ws.addRow([v.idReserva, v.fecha, v.cliente, v.email, v.asiento, v.metodoPago, v.monto, v.estado]);
    });

    ws.columns.forEach(col => { col.width = 20; });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Reporte_Ventas_${req.params.id}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
});

// 5. ENDPOINT: Enviar Reporte por Email
app.post('/api/eventos/:id/enviar-email', async (req, res) => {
    const { emailDestino } = req.body;
    const evento = eventosBD[req.params.id];

    if (!evento) return res.status(404).json({ exito: false, mensaje: 'Evento no encontrado' });

    try {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Historial de Ventas');
        ws.addRow(['ID Reserva', 'Fecha', 'Cliente', 'Email', 'Asiento', 'Método', 'Monto', 'Estado']);
        evento.historialVentas.forEach(v => ws.addRow([v.idReserva, v.fecha, v.cliente, v.email, v.asiento, v.metodoPago, v.monto, v.estado]));
        
        const buffer = await workbook.xlsx.writeBuffer();

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: 'tu_correo@gmail.com', pass: 'tu_password_app' }
        });

        await transporter.sendMail({
            from: '"Sistema Boletería" <noreply@boleteria.com>',
            to: emailDestino,
            subject: `Reporte Oficial de Ventas - ${evento.nombre}`,
            text: 'Se adjunta el historial consolidado de ventas del evento.',
            attachments: [{ filename: `Reporte_Ventas_${evento.nombre}.xlsx`, content: buffer }]
        });

        res.json({ exito: true, mensaje: `Reporte enviado con éxito a ${emailDestino}` });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Boletería iniciado en http://localhost:${PORT}`));