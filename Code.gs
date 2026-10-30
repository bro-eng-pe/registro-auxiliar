/**
 * REGISTRO AUXILIAR · Respaldo en Google Drive
 * ------------------------------------------------------------
 * 1) Escribe tu clave secreta (mínimo 12 caracteres) en CLAVE_INICIAL.
 * 2) Ejecuta una vez la función «instalar» (menú ▶ Ejecutar) y acepta los permisos.
 * 3) Implementar › Nueva implementación › Aplicación web:
 *      Ejecutar como: Yo · Quién tiene acceso: Cualquier persona
 * 4) Copia el enlace que termina en /exec y pégalo en el aplicativo
 *    (Ajustes › Respaldo en Google Drive) junto con la misma clave.
 * Al actualizar este código: Implementar › Administrar implementaciones › ✎ editar ›
 *    Versión: «Nueva versión» › Implementar. El enlace /exec y la clave no cambian.
 * Después de instalar puedes borrar la clave de CLAVE_INICIAL: queda guardada en el proyecto.
 */
var CLAVE_INICIAL = 'ESCRIBE-AQUI-TU-CLAVE-SECRETA';
var CARPETA = 'Registro Auxiliar - Datos';
var COPIAS_DIARIAS = 30;
var VERSION_GS = '2.6.1';
var MAX_MB = 25;                       // tamaño máximo por archivo de Materiales
var MARCA = 'Subido desde Registro Auxiliar';

function instalar() {
  var p = PropertiesService.getScriptProperties();
  if (CLAVE_INICIAL && CLAVE_INICIAL.indexOf('ESCRIBE-AQUI') !== 0) {
    if (CLAVE_INICIAL.length < 12) throw new Error('La clave debe tener al menos 12 caracteres.');
    p.setProperty('CLAVE', CLAVE_INICIAL);
  }
  if (!p.getProperty('CLAVE')) throw new Error('Primero escribe tu clave en CLAVE_INICIAL.');
  archivoDatos_();
  Logger.log('Listo. Carpeta y archivo de datos creados en tu Drive. Ahora implementa como aplicación web.');
}

function doGet() {
  return ContentService.createTextOutput('Registro Auxiliar: respaldo activo.');
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    var bloqueo = verificarClave_(req.clave);
    if (bloqueo) return json_({ ok: false, error: bloqueo });
    // Materiales: subir un archivo a Drive (no toca registro.json, no necesita esperar turno)
    if (req.accion === 'subir') return json_(subir_(req));
    lock.waitLock(30000);
    var datos = leer_();
    var ahora = Date.now();
    if (ahora <= (datos.ultimo || 0)) ahora = datos.ultimo + 1;

    if (req.accion === 'reiniciar') {
      respaldo_(datos, 'respaldo-antes-de-reinicio-' + fecha_() + '.json');
      var conservar = (req.extra && req.extra.conservar) || [];
      var nuevos = {};
      Object.keys(datos.recs).forEach(function (k) {
        var tipo = k.split(':')[0];
        var r = datos.recs[k];
        if (conservar.indexOf(tipo) >= 0 && !r.d) { r.s = ahora; nuevos[k] = r; }
      });
      datos = { epoca: Utilities.getUuid(), recs: nuevos, enviados: datos.enviados || {}, ultimo: ahora };
      guardar_(datos);
      return json_({ ok: true, epoca: datos.epoca, ahora: 0, recs: [] });
    }

    if (req.epoca && datos.epoca && req.epoca !== datos.epoca) {
      return json_({ ok: true, epocaCambio: true, epoca: datos.epoca });
    }

    (req.cambios || []).forEach(function (c) {
      if (!c || !c.k) return;
      var cur = datos.recs[c.k];
      if (!cur || c.t > cur.t || (c.t === cur.t && String(c.dev || '') > String(cur.dev || ''))) {
        datos.recs[c.k] = { t: c.t, dev: c.dev, v: c.v, d: !!c.d, s: ahora };
      }
    });

    var enviados = [];
    datos.enviados = datos.enviados || {};
    (req.correo || []).forEach(function (m) {
      if (!m || !m.id) return;
      if (datos.enviados[m.id]) { enviados.push(m.id); return; }
      if (!req.para) return;
      try {
        var adj = (m.adjuntos || []).map(function (a) {
          return Utilities.newBlob(Utilities.base64Decode(a.b64), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', a.nombre);
        });
        MailApp.sendEmail({ to: req.para, subject: m.asunto || 'Citaciones', body: m.texto || '', attachments: adj, name: 'Registro Auxiliar' });
        datos.enviados[m.id] = ahora;
        enviados.push(m.id);
      } catch (err) { /* se reintenta en la próxima sincronización */ }
    });

    var papeleraOk = [];
    (req.papelera || []).forEach(function (id) {
      try {
        var f = DriveApp.getFileById(String(id));
        if (f.getDescription() === MARCA) f.setTrashed(true);   // solo archivos subidos desde el aplicativo
        papeleraOk.push(id);
      } catch (err) { papeleraOk.push(id); /* ya no existe */ }
    });

    // Cambiar un archivo subido entre «privado» y «cualquiera con el enlace»
    var compartirOk = [];
    (req.compartir || []).forEach(function (c) {
      try {
        var f = DriveApp.getFileById(String(c.id));
        if (f.getDescription() === MARCA) {
          if (c.privado) f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
          else f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        }
        compartirOk.push(c.id);
      } catch (err) { compartirOk.push(c.id); }
    });

    var since = Number(req.since || 0);
    var salida = [];
    Object.keys(datos.recs).forEach(function (k) {
      var r = datos.recs[k];
      if (r.s > since && !(r.s === ahora && r.dev === req.dev)) salida.push({ k: k, t: r.t, dev: r.dev, v: r.v, d: r.d });
    });
    datos.ultimo = ahora;
    if (!datos.epoca) datos.epoca = Utilities.getUuid();
    guardar_(datos);
    copiaDiaria_(datos);
    var copia = req.accion === 'copia' ? copiaManual_(datos) : null;
    return json_({ ok: true, ahora: ahora, epoca: datos.epoca, recs: salida, enviados: enviados, copia: copia, papeleraOk: papeleraOk, compartirOk: compartirOk, version: VERSION_GS });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { }
  }
}

/* ---------- Materiales: archivos en «Registro Auxiliar - Datos › Materiales › grado › bimestre › …» ---------- */
function subir_(req) {
  if (!req.b64 || !req.nombre) return { ok: false, error: 'El archivo llegó vacío.', version: VERSION_GS };
  var bytes = Utilities.base64Decode(req.b64);
  if (bytes.length > MAX_MB * 1024 * 1024) return { ok: false, error: 'El archivo pasa de ' + MAX_MB + ' MB.', version: VERSION_GS };
  var destino = subcarpeta_(carpeta_(), 'Materiales');
  (req.ruta || []).forEach(function (n) { n = limpiarNombre_(n).slice(0, 90); if (n) destino = subcarpeta_(destino, n); });
  var f = destino.createFile(Utilities.newBlob(bytes, req.mime || 'application/octet-stream', limpiarNombre_(req.nombre) || 'archivo'));
  f.setDescription(MARCA);
  var compartido = false;
  if (!req.privado) { try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); compartido = true; } catch (e) { } }
  return { ok: true, subido: true, version: VERSION_GS, id: f.getId(), url: f.getUrl(), nombre: f.getName(), compartido: compartido, privado: !!req.privado };
}
function subcarpeta_(padre, nombre) { var it = padre.getFoldersByName(nombre); return it.hasNext() ? it.next() : padre.createFolder(nombre); }
function limpiarNombre_(n) { return String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(); }

/* ---------- Seguridad: clave y bloqueo tras 10 intentos fallidos ---------- */
function verificarClave_(clave) {
  var p = PropertiesService.getScriptProperties();
  var hasta = Number(p.getProperty('BLOQUEO_HASTA') || 0);
  if (hasta > Date.now()) return 'Respaldo bloqueado por intentos fallidos. Intenta en una hora.';
  var real = p.getProperty('CLAVE');
  if (!real) return 'El respaldo no está instalado. Ejecuta «instalar» en Apps Script.';
  if (clave !== real) {
    var n = Number(p.getProperty('FALLOS') || 0) + 1;
    if (n >= 10) { p.setProperty('BLOQUEO_HASTA', String(Date.now() + 3600000)); n = 0; }
    p.setProperty('FALLOS', String(n));
    return 'Clave del respaldo incorrecta.';
  }
  if (p.getProperty('FALLOS') !== '0') p.setProperty('FALLOS', '0');
  return null;
}

/* ---------- Archivos en Drive ---------- */
function carpeta_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('CARPETA_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  var c = DriveApp.createFolder(CARPETA);
  p.setProperty('CARPETA_ID', c.getId());
  return c;
}
function archivoDatos_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('ARCHIVO_ID');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) { } }
  var f = carpeta_().createFile('registro.json', JSON.stringify({ epoca: Utilities.getUuid(), recs: {}, enviados: {}, ultimo: 0 }), 'application/json');
  p.setProperty('ARCHIVO_ID', f.getId());
  return f;
}
function leer_() {
  var t = archivoDatos_().getBlob().getDataAsString('UTF-8');
  var d = t ? JSON.parse(t) : {};
  d.recs = d.recs || {};
  return d;
}
function guardar_(d) { archivoDatos_().setContent(JSON.stringify(d)); }
function fecha_() { return Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd'); }
function respaldo_(d, nombre) { carpeta_().createFile(nombre, JSON.stringify(d), 'application/json'); }
function copiaDiaria_(d) {
  var p = PropertiesService.getScriptProperties();
  var hoy = fecha_();
  if (p.getProperty('ULTIMA_COPIA') === hoy) return;
  respaldo_(d, 'copia-' + hoy + '.json');
  p.setProperty('ULTIMA_COPIA', hoy);
  var copias = [];
  var it = carpeta_().getFiles();
  while (it.hasNext()) { var f = it.next(); if (/^copia-\d{4}-\d{2}-\d{2}\.json$/.test(f.getName())) copias.push(f); }
  copias.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  copias.slice(COPIAS_DIARIAS).forEach(function (f) { f.setTrashed(true); });
}
/* Copia que pides desde el aplicativo antes de borrar (se puede restaurar desde Ajustes) */
var COPIAS_MANUALES = 50;
function copiaManual_(d) {
  var c = carpeta_(), sub, it = c.getFoldersByName('Respaldos');
  sub = it.hasNext() ? it.next() : c.createFolder('Respaldos');
  var recs = Object.keys(d.recs).map(function (k) { var r = d.recs[k]; return { k: k, t: r.t, dev: r.dev, v: r.v, d: r.d }; });
  var nombre = 'Respaldo-Registro-Auxiliar-' + Utilities.formatDate(new Date(), 'America/Lima', 'yyyy-MM-dd_HH-mm') + '.json';
  sub.createFile(nombre, JSON.stringify({ app: 'registro-auxiliar', fecha: new Date().toISOString(), recs: recs }), 'application/json');
  var lista = [], fs = sub.getFiles();
  while (fs.hasNext()) { var f = fs.next(); if (/^Respaldo-Registro-Auxiliar-/.test(f.getName())) lista.push(f); }
  lista.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  lista.slice(COPIAS_MANUALES).forEach(function (f) { f.setTrashed(true); });
  return nombre;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
