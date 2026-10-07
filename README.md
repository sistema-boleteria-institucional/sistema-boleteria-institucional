# Sistema de Boletería Institucional

Aplicación Node.js (Express) con base de datos Turso (libSQL).

## Puesta en marcha
    npm install
    npm start

## Variables de entorno
| Variable | Para qué sirve |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base de datos. Si faltan, funciona en memoria (solo pruebas). |
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
