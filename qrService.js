const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');

/**
 * Genera un código QR en formato DataURL con el logo institucional superpuesto al centro.
 * @param {string} textoData - Datos a codificar en el QR (ej. JSON string de la reserva)
 * @param {string|null} rutaLogo - Ruta opcional de la imagen del logo institucional
 */
async function generarQRConLogo(textoData, rutaLogo = null) {
    const canvasSize = 300;
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext('2d');

    // Generar el código QR base con corrección de errores nivel H (permite recuperar hasta 30% con superposición)
    await QRCode.toCanvas(canvas, textoData, {
        errorCorrectionLevel: 'H',
        margin: 2,
        width: canvasSize,
        color: { dark: '#000000', light: '#FFFFFF' }
    });

    // Cargar e incrustar logo en el centro si existe
    if (rutaLogo) {
        try {
            const logo = await loadImage(rutaLogo);
            const logoSize = canvasSize * 0.22;
            const x = (canvasSize - logoSize) / 2;
            const y = (canvasSize - logoSize) / 2;

            // Fondo blanco para legibilidad del logo
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(x - 5, y - 5, logoSize + 10, logoSize + 10);

            // Dibujar el logo
            ctx.drawImage(logo, x, y, logoSize, logoSize);
        } catch (err) {
            console.warn("No se pudo cargar el logo, se generó el QR sin logo:", err.message);
        }
    }

    return canvas.toDataURL('image/png');
}

module.exports = { generarQRConLogo };