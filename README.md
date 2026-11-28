# Sistema de Boletería Institucional

Aplicación Node.js (Express) con base de datos Turso (libSQL).

## Puesta en marcha
    npm install
    npm start

## Variables de entorno
| Variable | Para qué sirve |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base de datos (obligatoria). Si faltan, el servidor no arranca. |
| `AVISO_TEXTO` / `AVISO_HASTA` | Aviso arriba de todas las pantallas internas (p. ej. mantenimiento). `AVISO_HASTA` es opcional (fecha ISO, ej. `2026-10-14T04:00:00Z`) y oculta el aviso solo. Vacío = sin aviso. |
| `HMAC_SECRET` | Firma de los QR de las entradas. **Definila en producción.** Cambiarla invalida las entradas ya emitidas. |
| `BREVO_API_KEY` | Envío de entradas por email. |
| `MAIL_REMITENTE` | (Opcional) Email remitente. |
| `PUBLIC_URL` | (Opcional) URL pública para los enlaces de los emails. |
| `INITIAL_ADMIN_PASSWORD` | Clave del usuario `admin` en la primera puesta en marcha. Si no existe, se genera una y se muestra en la consola. |

## Seguridad
- Todas las rutas `/api` exigen sesión (token firmado, 12 h), salvo el login y la entrada firmada.
- Las contraseñas se guardan con scrypt. Las claves antiguas en texto plano se convierten solas al iniciar sesión.
- Solo se publican las pantallas del sitio, no el código del servidor.
- Los cambios de clave se hacen desde Superusuario → «Restablecer clave».

## Roles

| Rol | Puede |
|---|---|
| `vendedor` | Vender y consultar eventos |
| `puerta` | Solo escanear en la puerta |
| `organizador` | Vender, escanear en puerta, ver el listado de **sus** ventas (sin montos), crear/modificar/eliminar eventos (con los límites de tiempo de siempre) y crear/eliminar cupones. No ve montos, reportes, usuarios ni eventos **cerrados** (pasadas 5 h del inicio). Funciona con lista blanca: toda ruta que no esté en `rutaPermitidaOrganizador` (server.js) da 403. |
| `adm` | Además: usuarios, reportes, informes |
| `super` | Además: rutas `/api/super` |

## Alta de usuarios y claves (por link)

- Al crear un usuario se carga su **email**; el sistema le envía un link para que elija su clave (vence en 48 h, un solo uso). El administrador nunca ve ni define claves.
- "Restablecer clave" (panel de Superusuario) y "¿Olvidaste tu clave?" (pantalla de login) envían un link que vence en 1 h.
- Al cambiar la clave se cierran las sesiones abiertas de ese usuario.
- Requiere `BREVO_API_KEY` y `PUBLIC_URL` (por ejemplo `https://tu-app.onrender.com`; en Render, si falta, se usa `RENDER_EXTERNAL_URL`). Sin ellas no se puede dar de alta ni restablecer.
