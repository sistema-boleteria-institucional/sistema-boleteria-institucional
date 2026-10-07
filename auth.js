// Manejo de sesión en el navegador: guarda el token que entrega /api/login y lo envía
// en cada llamada a /api. Si el servidor dice que la sesión no es válida, vuelve al login.
(function () {
    var CLAVE_TOKEN = 'boleteriaToken';
    var nativo = window.fetch.bind(window);

    function leerToken() { try { return sessionStorage.getItem(CLAVE_TOKEN); } catch (e) { return null; } }
    function limpiar() {
        try { sessionStorage.removeItem(CLAVE_TOKEN); sessionStorage.removeItem('usuarioLogueado'); } catch (e) {}
    }

    // Una "sesión" guardada sin token (vieja o armada a mano) no sirve: se descarta.
    try {
        if (sessionStorage.getItem('usuarioLogueado') && !leerToken()) sessionStorage.removeItem('usuarioLogueado');
        if (!sessionStorage.getItem('usuarioLogueado')) sessionStorage.removeItem(CLAVE_TOKEN);
    } catch (e) {}

    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var esApi = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;
        if (!esApi) return nativo(input, init);

        var esLogin = url.indexOf('/api/login') !== -1;
        var token = leerToken();
        if (token && !esLogin) {
            init = init || {};
            var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
            h.set('Authorization', 'Bearer ' + token);
            init.headers = h;
        }

        return nativo(input, init).then(function (res) {
            if (esLogin) {
                // Se guarda el token ANTES de devolver la respuesta, para que la primera
                // llamada que haga la pantalla después de iniciar sesión ya lo lleve.
                return res.clone().json().then(function (d) {
                    if (d && d.token) { try { sessionStorage.setItem(CLAVE_TOKEN, d.token); } catch (e) {} }
                }).catch(function () {}).then(function () { return res; });
            }
            if (res.status === 401 && res.headers.get('X-Sesion') === 'invalida') {
                limpiar();
                if (!/index\.html$|\/$/.test(location.pathname)) location.href = 'index.html';
                else location.reload();
            }
            return res;
        });
    };
})();

// Ayudantes para mostrar datos de forma segura dentro de HTML (evita inyección de código).
window.esc = function (t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
};
// Para valores dentro de onclick="fn('...')": escapa para JavaScript y luego para HTML.
window.jsq = function (t) {
    return window.esc(String(t == null ? '' : t).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' '));
};
