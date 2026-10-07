const QRCode = require('qrcode');

/**
 * Genera un código QR puro en formato DataURL Base64
 * @param {string} textoData - Datos a codificar en el QR (ej. JSON string de la reserva)
 */
async function generarQRConLogo(textoData) {
    try {
        const qrDataUrl = await QRCode.toDataURL(textoData, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        return qrDataUrl;
    } catch (err) {
        console.error("Error al generar código QR:", err);
        return null;
    }
}

module.exports = { generarQRConLogo };