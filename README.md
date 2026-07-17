# Automatización de asignación de tareas (WhatsApp → OpenAI → Microsoft Planner)

Webhook de WhatsApp Business (Meta) que interpreta mensajes de texto o nota de voz
describiendo una tarea, extrae los campos con OpenAI, los valida de forma determinista,
crea la tarea en Microsoft Planner asignada al responsable correspondiente, y deja
registro auditable en Firebase (Firestore + Storage).

## Flujo

1. Un miembro del equipo escribe (texto o audio) por WhatsApp describiendo una tarea,
   idealmente siguiendo la plantilla:

   ```
   📝 Tarea:
   👤 Responsable:
   🏢 Cliente:
   📅 Fecha límite:
   ⏱️ Tiempo estimado:
   🚦 Urgencia:
   📌 Descripción:
   📎 Adjuntos:
   🎯 Asignado a:
   ```

2. Si es audio, se transcribe con Whisper (OpenAI).
3. OpenAI extrae los campos de la plantilla (o del texto libre) y se combinan con el
   borrador previo de la conversación (Firestore `conversaciones/{telefono}`).
4. Una capa determinista (`src/validacion/validarBorrador.js`, sin IA) valida
   completitud y reglas de negocio: fecha válida y futura, urgencia en
   `Alta|Media|Baja`, responsable/cliente existentes en las listas de Firestore.
   Si falta o es inválido algo, se responde por WhatsApp pidiendo puntualmente ese dato.
5. Con el borrador válido, se busca en Firestore (`planes/{responsableId}_{clienteId}`)
   el Plan/Bucket de Microsoft Planner correspondiente (los Planes ya existen en M365,
   uno por cada combinación responsable+cliente) y se crea la tarea vía Microsoft Graph.
6. Todo se persiste en Firestore (`tareas/{id}` + subcolección `eventos` de auditoría).
7. Se confirma al usuario por WhatsApp, o se le informa la novedad puntual si algo falló.

## Variables de entorno

Ver `.env.example`. En Render se configuran como variables de entorno del servicio
(nunca se commitea ningún secreto). El `FIREBASE_SERVICE_ACCOUNT` es el JSON completo
del service account de Firebase, en una sola línea.

## Correr localmente

```bash
npm install
cp .env.example .env   # completar valores reales
npm start
```

## Pruebas

```bash
npm test
```

Cubre la capa determinista (`validarBorrador.js`) y el parseo de fechas/tiempo
(`parsearTiempo.js`): fechas relativas ("mañana", "el viernes"), fechas explícitas,
urgencia, responsable/cliente inexistentes, y que nunca se "adivinen" valores no
mencionados por el usuario.

## Prerrequisito: Azure AD (Microsoft Graph / Planner)

Se necesita una App Registration en Azure AD con permisos de **aplicación**
(no delegados), con consentimiento de administrador:

- `Tasks.ReadWrite.All`
- `Group.Read.All`
- `User.Read.All`

Con `TENANT_ID`, `CLIENT_ID` y `CLIENT_SECRET` configurados, se puede correr:

```bash
GROUP_ID=<id-del-grupo-m365> npm run poblar-planes
```

Convención de nombres en Microsoft Planner (confirmada con el usuario): cada **Plan**
está nombrado como el **cliente**, y dentro de él cada **Bucket** está nombrado como
el **responsable** dueño de ese cliente. El script lista todos los Planes/Buckets del
grupo, empareja cada uno por **coincidencia exacta** (nombre o alias) contra las
colecciones `clientes` y `responsables` de Firestore — igual que el resto del sistema,
nunca adivina un emparejamiento ambiguo — y escribe directamente los documentos
`planes/{responsableId}_{clienteId}: { responsableId, clienteId, planId, bucketId }`.
Al final imprime un resumen de cuántas combinaciones quedaron guardadas y cuáles
Planes/Buckets no encontraron coincidencia (para corregir el nombre o agregar un alias
en Firestore y volver a correrlo; es seguro ejecutarlo varias veces, solo sobreescribe
los documentos que sí coinciden).

## Colecciones de Firestore que deben poblarse manualmente

- `responsables/{id}`: `{ nombre, alias: string[], email, activo }`
- `clientes/{id}`: `{ nombre, alias: string[], contactoPrincipal, telefonoContacto, nivelEscalamiento, responsableAsignadoPorDefecto, activo }`
- `planes/{responsableId}_{clienteId}`: `{ responsableId, clienteId, planId, bucketId }`

## Reporte de tareas

`GET /reportes/tareas` — protegido con Firebase Authentication (header
`Authorization: Bearer <idToken>`). Filtros opcionales por query string: `estado`,
`responsableEmail`, `cliente`, `limite`.

## Avisos de vencimiento por Microsoft Teams

Si una tarea tiene una **hora de entrega explícita** (ej. "mañana a las 3pm", no solo el
día), `src/teams/avisosVencimiento.js` revisa cada 5 minutos las tareas activas y envía un
aviso al canal de Teams configurado (`TEAMS_WEBHOOK_URL`) cuando falta ~1 hora para el
vencimiento. El aviso menciona la tarea, el cliente, el responsable actual, la fecha límite,
y a quién escalaría (siguiente nivel Auxiliar→Analista→Supervisor) si no se completa a tiempo.

El webhook debe crearse en Teams vía la app **"Workflows"** (plantilla *"Post to a channel
when a webhook request is received"*) — los Conectores clásicos ("Webhook entrante") fueron
retirados por Microsoft y ya no funcionan. **Ni los Conectores clásicos ni los webhooks de
Workflows soportan botones interactivos** (`Action.Submit`); marcar una tarea como
completada/en revisión directamente desde el mensaje de Teams requeriría un Bot de Microsoft
Teams (Bot Framework) — queda pendiente como una fase futura, no implementada.

Tareas sin hora explícita (solo con fecha) no generan aviso, ya que "1 hora antes" no tiene
un punto de referencia real sin una hora concreta.

## Notas de diseño

- **Nombre del bot**: el asistente se presenta como **ContaLigal** en el mensaje de
  bienvenida (cuando el primer mensaje de una conversación es un saludo sin datos de
  tarea, ver `mensajeBienvenida()` en `app.js`).
- **Sin control de acceso por remitente (de momento)**: cualquier número puede escribirle
  al bot y crear/asignar tareas; no hay una lista blanca de quién puede solicitar. Por
  eso cada tarea (`tareas/{id}`) guarda `telefonoSolicitante` y `nombreSolicitante`
  (este último es el nombre de perfil de WhatsApp de quien escribió — un dato
  autodeclarado por esa persona en su cuenta, no una identidad verificada) para poder
  auditar después quién pidió cada asignación. Si más adelante se requiere restringir
  el envío solo a directivos, se puede agregar una lista de números autorizados en
  Firestore y validarla antes de procesar el mensaje — no implementado todavía.
- El handshake `GET /` de verificación de Meta se conservó intacto, sin cambios.
- **Adjuntos (imágenes/documentos) deshabilitados por ahora**: Firebase Storage es un
  servicio de pago y aún no se ha decidido si es necesario, así que el bot responde
  que no puede guardar adjuntos y continúa la tarea sin el archivo (el audio sí se
  transcribe normalmente, no depende de Storage). El código para subirlos sigue en
  `src/storage/adjuntos.js` pero no se invoca desde `app.js`; si se decide habilitar
  Storage más adelante, basta con volver a conectarlo y definir `FIREBASE_STORAGE_BUCKET`.
- Si no se encuentra el Plan/Bucket para una combinación (responsable, cliente), la
  tarea igual se registra en Firestore con `estado: 'plan_no_encontrado'` para no
  perder la solicitud, y se le informa al usuario que debe avisar al administrador.
