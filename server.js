const express = require('express');
const { createClient } = require('@libsql/client');
const { Resend } = require('resend');
const { jsPDF } = require('jspdf');
require('jspdf-autotable');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Inicialización de Tablas
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

    await db.execute({
      sql: `INSERT OR IGNORE INTO usuarios (usuario, identificacion, clave, tipo) VALUES (?, ?, ?, ?)`,
      args: ['superadmin', 'SU-001', 'admin1234', 'super']
    });

    console.log("Base de datos conectada a Turso.");
  } catch (error) {
    console.error("Error initDB:", error);
  }
}
initDB();

// Generador de PDF en Buffer
function generarPDFBuffer(titulo, datosFilas, columnas) {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(titulo, 14, 20);
  doc.autoTable({
    startY: 30,
    head: [columnas],
    body: datosFilas,
  });
  const pdfArrayBuffer = doc.output('arraybuffer');
  return Buffer.from(pdfArrayBuffer);
}

// Envío de email con Resend
async function enviarEmailInforme(destino, asunto, contenidoTexto, pdfBuffer, nombreArchivo) {
  try {
    const payload = {
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to: destino,
      subject: asunto,
      html: `<p>${contenidoTexto}</p>`,
    };

    if (pdfBuffer && nombreArchivo) {
      payload.attachments = [
        {
          filename: nombreArchivo,
          content: pdfBuffer.toString('base64'),
        }
      ];
    }

    await resend.emails.send(payload);
    console.log(`Email enviado a ${destino}`);
    return true;
  } catch (err) {
    console.error("Error al enviar con Resend:", err);
    return false;
  }
}

// --- RUTAS API ---

app.post('/api/login', async (req, res) => {
  try {
    const { usuario, clave } = req.body;
    const result = await db.execute({
      sql: "SELECT * FROM usuarios WHERE usuario = ? AND clave = ?",
      args: [usuario, clave]
    });
    const user = result.rows[0];
    if (!user) return res.json({ exito: false, mensaje: "Credenciales incorrectas" });
    res.json({ exito: true, usuario: user.usuario, tipo: user.tipo, id: user.id });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: "Error interno" });
  }
});

app.get('/api/super/usuarios', async (req, res) => {
  try {
    const result = await db.execute("SELECT id, usuario, identificacion, tipo FROM usuarios");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/super/revelar-clave', async (req, res) => {
  const { claveSuper, usuarioIdTarget } = req.body;
  try {
    const check = await db.execute({
      sql: "SELECT * FROM usuarios WHERE tipo = 'super' AND clave = ?",
      args: [claveSuper]
    });
    if (check.rows.length === 0) return res.json({ exito: false, mensaje: "Clave superusuario inválida" });

    const target = await db.execute({
      sql: "SELECT clave FROM usuarios WHERE id = ?",
      args: [usuarioIdTarget]
    });
    res.json({ exito: true, clave: target.rows[0]?.clave });
  } catch (err) {
    res.json({ exito: false, mensaje: "Error al obtener clave" });
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
    res.json({ exito: false, mensaje: "El usuario ya existe o hubo un error" });
  }
});

app.delete('/api/super/usuarios/:id', async (req, res) => {
  try {
    await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [req.params.id] });
    res.json({ exito: true, mensaje: "Usuario eliminado" });
  } catch (err) {
    res.json({ exito: false, mensaje: "Error al eliminar usuario" });
  }
});

app.get('/api/eventos', async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM eventos ORDER BY fecha DESC");
    res.json(result.rows);
  } catch (err) {
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
    
    // Gradas
    for (let i = 1; i <= Math.min(dispGrada, 12); i++) {
      await db.execute({
        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'Grada', ?)",
        args: [id, `G1-${i}`, precioGradas]
      });
    }
    for (let i = 1; i <= Math.min(dispGrada - 12, 12); i++) {
      await db.execute({
        sql: "INSERT INTO asientos (evento_id, codigoAsiento, tipoZona, precio) VALUES (?, ?, 'Grada', ?)",
        args: [id, `G2-${i}`, precioGradas]
      });
    }

    res.json({ exito: true, mensaje: "Evento guardado" });
  } catch (err) {
    res.json({ exito: false, mensaje: "Error al crear evento" });
  }
});

app.get('/api/eventos/:id/asientos', async (req, res) => {
  try {
    const result = await db.execute({ sql: "SELECT * FROM asientos WHERE evento_id = ?", args: [req.params.id] });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/api/eventos/:id/informe', async (req, res) => {
  try {
    const id = req.params.id;
    const ventas = await db.execute({
      sql: `SELECT v.*, a.codigoAsiento FROM ventas v JOIN asientos a ON v.asiento_id = a.id WHERE v.evento_id = ?`,
      args: [id]
    });
    const totalRecaudado = ventas.rows.reduce((sum, item) => sum + (item.monto_total || 0), 0);
    const asistencias = ventas.rows.filter(v => v.asistio === 1).length;

    res.json({
      totalVendidas: ventas.rows.length,
      asistentesReales: asistencias,
      totalRecaudado: totalRecaudado,
      detalles: ventas.rows
    });
  } catch (err) {
    res.status(500).json({ totalVendidas: 0, asistentesReales: 0, totalRecaudado: 0, detalles: [] });
  }
});

app.post('/api/cupones/crear', async (req, res) => {
  const { codigo, porcentaje } = req.body;
  try {
    await db.execute({
      sql: "INSERT OR REPLACE INTO cupones (codigo, porcentaje) VALUES (?, ?)",
      args: [codigo, porcentaje]
    });
    res.json({ exito: true, mensaje: "Cupón guardado correctamente" });
  } catch (err) {
    res.json({ exito: false, mensaje: "Error al guardar cupón" });
  }
});

app.post('/api/cupones/validar', async (req, res) => {
  const { codigo } = req.body;
  try {
    const result = await db.execute({
      sql: "SELECT porcentaje FROM cupones WHERE codigo = ?",
      args: [codigo]
    });
    if (result.rows.length > 0) {
      res.json({ valido: true, porcentaje: result.rows[0].porcentaje });
    } else {
      res.json({ valido: false, mensaje: "Cupón no encontrado" });
    }
  } catch (err) {
    res.json({ valido: false, mensaje: "Error al validar cupón" });
  }
});

app.post('/api/super/configuracion', async (req, res) => {
  const { clave, valor } = req.body;
  try {
    await db.execute({
      sql: "INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)",
      args: [clave, valor]
    });
    res.json({ exito: true, mensaje: "Configuración guardada" });
  } catch (err) {
    res.json({ exito: false, mensaje: "Error al guardar configuración" });
  }
});

app.post('/api/ventas/procesar', async (req, res) => {
  const { evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total } = req.body;
  try {
    await db.execute({ sql: "UPDATE asientos SET vendido = 1 WHERE id = ?", args: [asiento_id] });
    await db.execute({
      sql: "INSERT INTO ventas (evento_id, asiento_id, nombre_cliente, apellido_cliente, contacto, email, metodo_pago, monto_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [evento_id, asiento_id, nombre, apellido, contacto, email, metodo_pago, monto_total]
    });

    const asientoInfo = await db.execute({ sql: "SELECT codigoAsiento FROM asientos WHERE id = ?", args: [asiento_id] });
    const codAsiento = asientoInfo.rows[0]?.codigoAsiento || 'N/A';

    // Generar PDF y enviar mail al cliente
    if (email) {
      const pdfBuffer = generarPDFBuffer(
        "Comprobante de Entrada",
        [[nombre + " " + apellido, codAsiento, metodo_pago, `$${monto_total}`]],
        ["Cliente", "Asiento", "Pago", "Monto"]
      );

      await enviarEmailInforme(
        email,
        "Tu Entrada para el Evento",
        `Hola ${nombre}, adjuntamos tu entrada para el asiento ${codAsiento}.`,
        pdfBuffer,
        `Entrada-${codAsiento}.pdf`
      );
    }

    res.json({ exito: true, mensaje: "Venta registrada exitosamente" });
  } catch (err) {
    console.error(err);
    res.json({ exito: false, mensaje: "Error al procesar la venta" });
  }
});

// Tarea Cron: Ejecución cada 12 horas para informes automáticos
cron.schedule('0 */12 * * *', async () => {
  try {
    const config = await db.execute({ sql: "SELECT valor FROM configuracion WHERE clave = 'email_informe'", args: [] });
    const emailDestino = config.rows[0]?.valor;
    if (!emailDestino) return;

    const eventos = await db.execute({ sql: "SELECT * FROM eventos WHERE informe_enviado = 0", args: [] });
    for (const ev of eventos.rows) {
      const ventas = await db.execute({
        sql: `SELECT v.*, a.codigoAsiento FROM ventas v JOIN asientos a ON v.asiento_id = a.id WHERE v.evento_id = ?`,
        args: [ev.id]
      });

      const filas = ventas.rows.map(v => [
        `${v.nombre_cliente} ${v.apellido_cliente}`,
        v.codigoAsiento,
        v.metodo_pago,
        `$${v.monto_total}`
      ]);

      const pdfBuffer = generarPDFBuffer(
        `Informe General: ${ev.nombre}`,
        filas,
        ["Cliente", "Asiento", "Método Pago", "Monto"]
      );

      const enviado = await enviarEmailInforme(
        emailDestino,
        `Informe Automático: ${ev.nombre}`,
        `Se adjunta el reporte de ventas del evento ${ev.nombre}. Total entradas: ${ventas.rows.length}`,
        pdfBuffer,
        `Informe-${ev.id}.pdf`
      );

      if (enviado) {
        await db.execute({ sql: "UPDATE eventos SET informe_enviado = 1 WHERE id = ?", args: [ev.id] });
      }
    }
  } catch (err) {
    console.error("Error en tarea programada Cron:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
