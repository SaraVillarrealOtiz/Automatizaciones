// Puebla las colecciones `responsables` y `clientes` de Firestore a partir de dos
// archivos Excel exportados manualmente:
//
//   - "Usuarios microsoft.xlsx"                (hoja "usuarios"): directorio de Azure AD.
//   - "planes_con_buckets_RESPONSABLES.xlsx"   (hoja "planes_con_buckets"): un Plan de
//     Planner por cliente, con sus Buckets (etapas) y la cadena de escalamiento
//     "Auxiliar: X | Analista: Y | Supervisor: Z" en la columna "Responsables".
//
// El PlanId/BucketId ya vienen en el Excel (no hace falta llamar a Microsoft Graph
// para descubrirlos), asi que este script solo necesita FIREBASE_SERVICE_ACCOUNT.
//
// El mapeo de nombres cortos ("Natalia", "Jose Bueno", ...) a persona/correo real fue
// confirmado explicitamente con el usuario (no se adivina) y esta en MAPA_PERSONAS.
//
// Uso:
//   npm run poblar-clientes

require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const { getDb } = require('../src/firestore/firebaseAdmin');
const { limpiar } = require('../src/interpretacion/normalizarTexto');

const RUTA_USUARIOS = path.join(__dirname, '..', 'Usuarios microsoft.xlsx');
const RUTA_PLANES = path.join(__dirname, '..', 'planes_con_buckets_RESPONSABLES.xlsx');

// Confirmado explícitamente con el usuario (2026-07-10). Cada clave es el nombre corto
// tal como aparece en la columna "Responsables" del Excel de planes.
// `aliasExtra` agrega alias adicionales (ej. solo el primer nombre) sin quitar el alias
// principal usado en la cadena de escalamiento del Excel. Agregado 2026-07-21 para que
// el usuario pueda referirse a cada persona solo por su primer nombre en WhatsApp.
// OJO: hay DOS personas llamadas "Luisa" (Luisa Alejandra Sánchez Romero y Luisa
// Fernanda Garay Rojas) — por eso a la primera se le sigue diciendo "Alejandra" (su
// segundo nombre) y NO se le agrega "Luisa" como alias, para no generar ambiguedad
// entre las dos. Confirmado explicitamente con el usuario (2026-07-10).
const MAPA_PERSONAS = {
  Natalia: { nombre: 'Natalia Muñoz Calderón', email: 'contabilidad3@jpulido.com.co', activo: true },
  Linda: { nombre: 'Linda Nahomy Lozada Pérez', email: 'contabilidad4@jpulido.com.co', activo: true },
  Alejandra: { nombre: 'Luisa Alejandra Sánchez Romero', email: 'contabilidad@jpulido.com.co', activo: true },
  Sofia: { nombre: 'Sofía Otálora Raigozo', email: 'analista2@jpulido.com.co', activo: true },
  Ruben: { nombre: 'Rubén Darío Palencia Cubillos', email: 'analista3@jpulido.com.co', activo: true },
  'Jose Bueno': { nombre: 'Jose Manuel Bueno Perea', email: 'analista5@jpulido.com.co', activo: true, aliasExtra: ['Jose'] },
  Luisa: { nombre: 'Luisa Fernanda Garay Rojas', email: 'analista1@jpulido.com.co', activo: true },
  Jeysson: { nombre: 'Jeysson Alexander Pulido Santana', email: 'gerencia@jpulido.com.co', activo: true },
  Cristina: { nombre: 'Revisoría Fiscal', email: 'Rfiscal@jpulido.com.co', activo: true },
  // Correo aun no definido en la compañia. Se guarda inactivo/sin correo: la validacion
  // determinista bloquea asignarle tareas y la cadena de escalamiento no puede avanzar
  // hacia el hasta que se complete (solo queda alerta interna, no se asume nada).
  Ricardo: { nombre: 'Ricardo', email: null, activo: false },
  // Agregada 2026-07-16: aparece en la cadena de escalamiento de al menos un cliente
  // ("Analista: Sara Villarreal"). Coincide con el directorio de Azure AD.
  'Sara Villarreal': { nombre: 'Sara Villarreal Ortiz', email: 'contabilidad2@jpulido.com.co', activo: true, aliasExtra: ['Sara'] },
};

function slugify(texto) {
  return texto
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// "Coordinador" en el Excel de origen es el mismo rol que nosotros llamamos "Supervisor"
// (confirmado con el usuario, 2026-07-16) — solo cambio de nombre en la fuente, no un
// nivel nuevo. Cada rol puede traer varias personas separadas por coma (ej.
// "Coordinador: Jose Bueno, Luisa"): cualquiera de ellas es valida para ese nivel.
const ALIAS_ROL_FUENTE = { auxiliar: 'Auxiliar', analista: 'Analista', supervisor: 'Supervisor', coordinador: 'Supervisor' };

function parsearCadenaEscalamiento(cadena) {
  const roles = { Auxiliar: [], Analista: [], Supervisor: [] };
  if (!cadena || cadena === '(contenedor / no aplica)' || cadena === 'SIN RESPONSABLE') {
    return roles;
  }
  for (const parte of cadena.split('|').map((s) => s.trim())) {
    const m = parte.match(/^(Auxiliar|Analista|Supervisor|Coordinador):\s*(.+)$/i);
    if (m) {
      const rol = ALIAS_ROL_FUENTE[m[1].toLowerCase()];
      const nombres = m[2].split(',').map((n) => n.trim()).filter(Boolean);
      roles[rol].push(...nombres);
    }
  }
  return roles;
}

async function main() {
  const db = getDb();

  // 1. Poblar `responsables` a partir de MAPA_PERSONAS (fuente de verdad confirmada).
  // La cadena de escalamiento en el Excel no siempre respeta mayusculas/minusculas
  // (ej. "JEYSSON", "CRISTINA"), asi que el lookup se hace por nombre normalizado,
  // igual que el resto del sistema (nunca coincidencia difusa, solo case/acentos).
  const idPorNombreNormalizado = {};
  for (const [nombreCorto, datos] of Object.entries(MAPA_PERSONAS)) {
    const id = slugify(datos.nombre);
    idPorNombreNormalizado[limpiar(nombreCorto)] = id;
    await db
      .collection('responsables')
      .doc(id)
      .set({
        nombre: datos.nombre,
        alias: [nombreCorto, ...(datos.aliasExtra || [])],
        email: datos.email,
        activo: datos.activo,
      });
  }
  console.log(`responsables: ${Object.keys(MAPA_PERSONAS).length} documentos escritos.`);

  // 2. Leer el Excel de planes/buckets y agrupar filas por Plan.
  const wbPlanes = XLSX.readFile(RUTA_PLANES);
  const filas = XLSX.utils.sheet_to_json(wbPlanes.Sheets['planes_con_buckets'], { defval: '' });

  const planesPorTitulo = new Map();
  for (const fila of filas) {
    if (!fila.Plan) continue;
    // El nombre de esta columna cambio de "Responsables" a "Responsable" en el archivo
    // (2026-07-16); se aceptan ambos por si vuelve a variar.
    const cadenaFila = fila.Responsable || fila.Responsables;
    if (!planesPorTitulo.has(fila.Plan)) {
      planesPorTitulo.set(fila.Plan, { filas: [], responsablesCadena: cadenaFila });
    }
    planesPorTitulo.get(fila.Plan).filas.push(fila);
  }

  let clientesEscritos = 0;
  const omitidos = [];
  const rolesSinPersonaConocida = new Set();

  for (const [tituloPlan, { filas: filasPlan, responsablesCadena }] of planesPorTitulo) {
    if (responsablesCadena === '(contenedor / no aplica)') {
      omitidos.push(`${tituloPlan} (contenedor interno, no es cliente)`);
      continue;
    }

    const bucketInicio = filasPlan.find((f) => f.Bucket === 'Inicio');
    if (!bucketInicio) {
      omitidos.push(`${tituloPlan} (sin bucket "Inicio")`);
      continue;
    }

    const cadena = parsearCadenaEscalamiento(responsablesCadena);
    const roleIds = {};
    for (const rol of ['Auxiliar', 'Analista', 'Supervisor']) {
      const nombresCortos = cadena[rol];
      const ids = [];
      for (const nombreCorto of nombresCortos) {
        const personaId = idPorNombreNormalizado[limpiar(nombreCorto)];
        if (!personaId) {
          rolesSinPersonaConocida.add(nombreCorto);
        } else if (!ids.includes(personaId)) {
          ids.push(personaId);
        }
      }
      roleIds[rol] = ids;
    }

    const clienteId = slugify(tituloPlan);
    await db
      .collection('clientes')
      .doc(clienteId)
      .set({
        nombre: tituloPlan,
        alias: [],
        activo: true,
        plannerGroupId: filasPlan[0].GroupId,
        plannerPlanId: filasPlan[0].PlanId,
        bucketInicioId: bucketInicio.BucketId,
        auxiliarIds: roleIds.Auxiliar,
        analistaIds: roleIds.Analista,
        supervisorIds: roleIds.Supervisor,
      });

    clientesEscritos += 1;
  }

  console.log(`\nclientes: ${clientesEscritos} documentos escritos.`);
  if (omitidos.length) {
    console.log(`\nPlanes omitidos (${omitidos.length}):`);
    omitidos.forEach((o) => console.log(`  - ${o}`));
  }
  if (rolesSinPersonaConocida.size) {
    console.log(`\nNombres en la cadena de escalamiento sin mapeo en MAPA_PERSONAS (revisar y agregar):`);
    rolesSinPersonaConocida.forEach((n) => console.log(`  - "${n}"`));
  }
  console.log('\nListo. Clientes sin alguno de los 3 roles configurados quedaran bloqueados por');
  console.log('la validacion determinista hasta que se complete su cadena de escalamiento.');
}

main().catch((err) => {
  console.error('Error poblando clientes/responsables:', err.message);
  process.exit(1);
});
