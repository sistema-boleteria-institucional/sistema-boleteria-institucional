const express = require('express');
const path = require('path');
const app = express();

// Middlewares
app.use(express.json());
// Servir archivos directamente desde la raíz (sin carpeta public)
app.use(express.static(__dirname));

// ==========================================
// BASE DE DATOS EN MEMORIA (SIMULACIÓN)
// ==========================================

let usuarios = [
    { id: 1, usuario: 'admin', clave: '1234', tipo: 'super', identificacion: 'SUP-01' },
    { id: 2, usuario: 'operario1', clave: '1234', tipo: 'vendedor', identificacion: 'VEN-01' }
];

let eventos = [
    { 
        id: 'EV-2026', 
        nombre: 'Festival de Música', 
        fecha: '2026-10-15', 
        hora: '20:00', 
        precioGeneral: 1500, 
        dispGen: 112, 
        precioGradas: 3000, 
        dispGrada: 24 
    }
];

let cupones = [
    { codigo: 'DESCUENTO10', porcentaje: 10 }
];

let ventas = [];
let emailInformeGlobal = '';

// Almacenamiento de mapas de asientos por ID de evento
let asientosMap = {}; 

// Función para inicializar los asientos de un evento
function inicializarAsientos(eventoId) {
    if (asientosMap[eventoId]) return;
    
    const eventoObj = eventos.find(e => e.id === eventoId);
    
    // Valores predeterminados o los ingresados por el operador
    const pGen = eventoObj ? Number(eventoObj.precioGeneral) : 1500;
    const pGrada = eventoObj ? Number(eventoObj.precioGradas) : 3000;
    
    // Asignación de capacidad respetando los topes máximos
    const maxGenConfig = eventoObj ? Number(eventoObj.dispGen) : 112;
    const maxGradaConfig = eventoObj ? Number(eventoObj.dispGrada) : 24;

    const totalGen = Math.min(maxGenConfig, 112);     // Tope máximo 112
    const totalGrada = Math.min(maxGradaConfig, 24);   // Tope máximo 24

    let lista = [];
    let idCounter = 1;

    // Generar la cantidad exacta de asientos de General asignados
    for (let i = 1; i <= totalGen; i++) {
        lista.push({
            id: idCounter++,
            codigoAsiento: `GEN-A${i}`,
            tipoZona: 'General',
            precio: pGen,
            vendido: 0,
            habilitado: 1,
            asistio: 0
        });
    }

    // Generar la cantidad exacta de asientos de Gradas asignados (repartidos entre Grada 1 y 2)
    const porGrada1 = Math.ceil(totalGrada / 2);
    const porGrada2 = totalGrada - porGrada1;

    for (let i = 1; i <= porGrada1; i++) {
        lista.push({ 
            id: idCounter++, 
            codigoAsiento: `G1-${i}`, 
            tipoZona: 'Grada', 
            precio: pGrada, 
            vendido: 0, 
            habilitado: 1, 
            asistio: 0 
        });
    }
    for (let i = 1; i <= porGrada2; i++) {
        lista.push({ 
            id: idCounter++, 
            codigoAsiento: `G2-${i}`, 
            tipoZona: 'Grada', 
            precio: pGrada, 
            vendido: 0, 
            habilitado: 1, 
            asistio: 0 
        });
    }

    asientosMap[eventoId] = lista;
}
// Inicializar asientos para el evento predeterminado
inicializarAsientos('EV-2026');

// ==========================================
// RUTAS DE LA API (ENDPOINTS)
// ==========================================

// 1. Autenticación de usuarios
app.post('/api/login', (req, res) => {
    const { usuario, clave } = req.body;
    const usr = usuarios.find(u => u.usuario.toLowerCase() === (usuario || '').toLowerCase() && u.clave === clave);
    
    if (usr) {
        res.json({ exito: true, usuario: usr.usuario, tipo: usr.tipo, id: usr.id });
    } else {
        res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
    }
});

// 2. Obtener lista de eventos
app.get('/api/eventos', (req, res) => {
    res.json(eventos);
});

// 3. Crear nuevo evento
app.post('/api/eventos/crear', (req, res) => {
    const nuevoEvento = req.body;
    
    if (eventos.some(e => e.id === nuevoEvento.id)) {
        return res.json({ exito: false, mensaje: 'El ID del evento ya existe' });
    }
    
    eventos.push(nuevoEvento);
    inicializarAsientos(nuevoEvento.id);
    res.json({ exito: true, mensaje: 'Evento creado exitosamente' });
});

// 4. Obtener asientos de un evento
app.get('/api/eventos/:id/asientos', (req, res) => {
    const { id } = req.params;
    if (!asientosMap[id]) {
        inicializarAsientos(id);
    }
    res.json(asientosMap[id] || []);
});

// 5. Validar cupón de descuento
app.post('/api/cupones/validar', (req, res) => {
    const { codigo } = req.body;
    const cup = cupones.find(c => c.codigo.toUpperCase() === (codigo || '').toUpperCase());
    
    if (cup) {
        res.json({ valido: true, porcentaje: cup.porcentaje });
    } else {
        res.json({ valido: false, mensaje: 'Cupón no válido o expirado' });
    }
});

// 6. Crear nuevo cupón
app.post('/api/cupones/crear', (req, res) => {
    const { codigo, porcentaje } = req.body;
    
    if (cupones.some(c => c.codigo.toUpperCase() === codigo.toUpperCase())) {
        return res.json({ exito: false, mensaje: 'El código del cupón ya existe' });
    }
    
    cupones.push({ codigo, porcentaje });
    res.json({ exito: true, mensaje: 'Cupón guardado correctamente' });
});

// 7. Procesar venta de entrada
app.post('/api/ventas/procesar', (req, res) => {
    const venta = req.body;
    const listaAsientos = asientosMap[venta.evento_id];
    
    if (!listaAsientos) {
        return res.status(400).json({ exito: false, mensaje: 'Evento no encontrado' });
    }

    const asiento = listaAsientos.find(a => a.id === venta.asiento_id);
    
    if (!asiento) {
        return res.json({ exito: false, mensaje: 'Asiento no válido' });
    }
    
    if (asiento.vendido === 1) {
        return res.json({ exito: false, mensaje: 'El asiento ya fue vendido previamente' });
    }

    // Marcar como vendido y guardar la transacción
    asiento.vendido = 1;
    ventas.push({ 
        ...venta, 
        id: ventas.length + 1, 
        codigoAsiento: asiento.codigoAsiento,
        fechaCompra: new Date() 
    });

    res.json({ exito: true, mensaje: 'Venta registrada y entrada generada correctamente' });
});

// 8. Obtener informes por evento
app.get('/api/informe/:eventoId', (req, res) => {
    const { eventoId } = req.params;
    const ventasEvento = ventas.filter(v => v.evento_id === eventoId);
    const listaAsientos = asientosMap[eventoId] || [];

    const vendidas = ventasEvento.length;
    const recaudado = ventasEvento.reduce((acc, curr) => acc + Number(curr.monto_total), 0);
    const asistentes = listaAsientos.filter(a => a.vendido === 1 && a.asistio === 1).length;

    res.json({ vendidas, asistentes, recaudado });
});

// 9. Gestión de Usuarios: Crear
app.post('/api/usuarios/crear', (req, res) => {
    const nuevoUsr = req.body;
    
    if (usuarios.some(u => u.usuario.toLowerCase() === nuevoUsr.usuario.toLowerCase())) {
        return res.json({ exito: false, mensaje: 'El nombre de usuario ya existe' });
    }

    nuevoUsr.id = usuarios.length + 1;
    usuarios.push(nuevoUsr);
    res.json({ exito: true, mensaje: 'Usuario registrado exitosamente' });
});

// 10. Gestión de Usuarios: Listar (Superusuario)
app.get('/api/super/usuarios', (req, res) => {
    res.json(usuarios);
});

// 11. Gestión de Usuarios: Revelar Clave (Superusuario)
app.post('/api/super/revelar-clave', (req, res) => {
    const { claveSuper, usuarioIdTarget } = req.body;
    const superAdmin = usuarios.find(u => (u.tipo === 'super' || u.tipo === 'admin') && u.clave === claveSuper);
    
    if (!superAdmin) {
        return res.status(403).json({ exito: false, mensaje: 'Clave de Superusuario incorrecta' });
    }

    const target = usuarios.find(u => u.id === usuarioIdTarget);
    if (target) {
        res.json({ exito: true, clave: target.clave });
    } else {
        res.status(404).json({ exito: false, mensaje: 'Usuario no encontrado' });
    }
});

// 12. Gestión de Usuarios: Eliminar
app.delete('/api/super/usuarios/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    usuarios = usuarios.filter(u => u.id !== id);
    res.json({ exito: true, mensaje: 'Usuario eliminado' });
});

// 13. Configuración de Email para Informes
app.post('/api/config/email-informe', (req, res) => {
    emailInformeGlobal = req.body.email;
    res.json({ exito: true, mensaje: `Email guardado: ${emailInformeGlobal}` });
});

// Servir la página principal desde la raíz
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// INICIALIZACIÓN DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
    console.log(`===========================================`);
});
