# WhatsApp para Poda

Tu cuenta de WhatsApp manejada desde Claude: mandar mensajes, leer chats, verificar
si un número tiene WhatsApp y mandar presupuestos, pidiéndoselo en castellano.

Son dos piezas:

- **WAHA** (contenedor Docker) mantiene la sesión de WhatsApp viva y la expone como API HTTP.
- **Servidor MCP** (`mcp-server/`) traduce esa API a herramientas que Claude puede usar,
  y aplica los límites de envío.

```
Claude  ──MCP──>  mcp-server  ──HTTP──>  WAHA  ──>  WhatsApp
                      └── topes por hora / día / contactos nuevos
```

## Antes de empezar, lo que hay que saber

WAHA no es oficial: se conecta como si fuera WhatsApp Web. **Viola los términos de
servicio de WhatsApp y el número se puede banear sin aviso.** Los dos disparadores
principales son volumen alto en poco tiempo y mensajes a desconocidos, que es
justamente la prospección en frío.

Por eso: **usá un chip secundario, no el número principal del negocio.** Los topes
de envío vienen puestos por defecto y el servidor los aplica siempre; no se pueden
saltear desde el chat.

Si algún día el volumen justifica formalizarlo, la salida limpia es la
[Cloud API oficial de Meta](https://developers.facebook.com/docs/whatsapp/cloud-api):
sin riesgo de baneo, pero con número dedicado, verificación de negocio y pago por
plantilla entregada.

## Instalación

Necesitás Docker y Node 20 o superior.

```bash
git clone <este-repo> whatsapp-poda
cd whatsapp-poda

# 1. Configuración
cp .env.example .env
openssl rand -hex 24          # copiá el resultado a WAHA_API_KEY en .env

# 2. Levantar WAHA
docker compose up -d
docker compose ps             # debería decir "healthy" después de ~30 s

# 3. Compilar el servidor MCP
cd mcp-server
npm install
npm run build
npm run prueba                # 9 verificaciones contra un WAHA simulado
```

Con eso listo, abrí Claude Code en la carpeta del proyecto. El archivo `.mcp.json`
ya deja el servidor configurado: Claude te va a pedir confirmación la primera vez.

> Si Claude no encuentra el servidor, reemplazá en `.mcp.json` la ruta relativa
> `mcp-server/dist/index.js` por la ruta absoluta en tu máquina.

## Vincular el primer número

Pedile a Claude: **"vinculá mi número de WhatsApp"**.

Te muestra un QR. En el celular: WhatsApp → Ajustes → Dispositivos vinculados →
Vincular dispositivo. El QR dura menos de un minuto; si se vence, pedíselo de nuevo.

Verificá con **"¿qué números tengo vinculados?"**.

## Cambiar de número

Cada número es una **sesión** con su propio nombre. Por eso hay dos caminos según
lo que necesites:

### Reemplazar el número actual

> "cambiá el número de WhatsApp"

Desvincula el que está y te da un QR nuevo para poner otro en la misma sesión.
El historial de la cuenta vieja deja de estar accesible. Sirve cuando cambiaste
de chip o quemaste un número.

### Tener varios números a la vez

> "vinculá otro número en la sesión secundario"

Quedan los dos vivos en paralelo. Después le aclarás a Claude cuál usar:

> "mandale un mensaje a Marcelo **desde el secundario**"

Si no aclarás nada usa el de `WA_SESION_DEFAULT` en el `.env` (por defecto,
`principal`). Los nombres los elegís vos: `principal`, `secundario`, `presupuestos`,
lo que te sirva.

### Dar de baja un número

> "desvinculá el número secundario"

Cierra la sesión y borra sus credenciales del servidor, igual que cerrar el
dispositivo vinculado desde el celular.

**Ojo con los topes al cambiar:** el contador de envíos es global, no por número.
Si vinculás un chip nuevo, sigue contando lo que ya mandaste desde el anterior en
las últimas 24 h. Es a propósito: lo que se protege es tu ritmo de envío, que es
lo que dispara las detecciones.

## Qué le podés pedir

| Herramienta | Para qué |
|---|---|
| `listar_numeros` | Ver qué números hay vinculados y su estado |
| `vincular_numero` | Vincular uno nuevo (devuelve el QR) |
| `cambiar_numero` | Reemplazar el número de una sesión |
| `desvincular_numero` | Cerrar una sesión |
| `estado_numero` | Ver si una sesión está operativa |
| `enviar_mensaje` | Mandar un texto |
| `enviar_archivo` | Mandar una foto o un PDF desde una URL |
| `listar_chats` | Ver las conversaciones recientes |
| `leer_mensajes` | Leer un chat |
| `marcar_leido` | Poner en visto |
| `verificar_numero` | Ver si un número tiene WhatsApp (no gasta cupo) |
| `buscar_contacto` | Buscar en la agenda por nombre o número |
| `estado_limites` | Ver cuánto cupo de envío queda |

En la práctica no las nombrás: le decís *"fijate si tengo mensajes nuevos"* o
*"mandale el presupuesto a Laura"* y Claude elige.

### Números y códigos de país

Siempre con código de país y sin `+`. Para Argentina va el **9** después del 54:

```
5491122334455       correcto
541122334455        le falta el 9, no va a llegar
1122334455          rechazado, sin código de país
```

Si tenés dudas con un número, `verificar_numero` te dice si existe sin mandarle nada.

## Los límites de envío

Vienen así en `.env.example`:

| Variable | Por defecto | Qué controla |
|---|---|---|
| `LIMITE_POR_HORA` | 20 | Mensajes en las últimas 60 min |
| `LIMITE_POR_DIA` | 100 | Mensajes en las últimas 24 h |
| `LIMITE_NUEVOS_POR_DIA` | 20 | Contactos a los que nunca les escribiste, en 24 h |
| `RETARDO_MIN_MS` / `RETARDO_MAX_MS` | 8000 / 25000 | Espera al azar antes de cada envío |

Las ventanas son **móviles**: cuentan hacia atrás desde ahora, no desde medianoche.
Es lo que mira WhatsApp para decidir si un número se porta raro.

Además, antes de cada mensaje el servidor simula que estás tipeando, un tiempo
proporcional al largo del texto. El intervalo aleatorio también es a propósito:
un ritmo fijo es una firma de bot.

Si un tope se alcanza, **no se envía nada** y te avisa cuántos minutos faltan.
`verificar_numero` y todo lo que es lectura no gastan cupo.

Para aflojar los topes hay que editar el `.env` y reiniciar el MCP. No se pueden
cambiar desde la conversación, a propósito: son un freno, y un freno que se
desactiva pidiéndolo amablemente no frena nada.

## Mantenimiento

```bash
docker compose logs -f waha      # ver qué está pasando
docker compose restart waha      # reiniciar sin perder la sesión
docker compose pull && docker compose up -d   # actualizar WAHA
```

**Respaldá `datos/waha/`.** Ahí viven las credenciales de las sesiones: si se
pierden hay que volver a escanear el QR. Por lo mismo, esa carpeta está en
`.gitignore` y nunca debe ir al repo — equivale a la cuenta entera.

### Si algo no anda

| Síntoma | Qué mirar |
|---|---|
| "No se pudo contactar a WAHA" | `docker compose ps`; si está caído, `docker compose up -d` |
| La sesión queda en `FAILED` | `docker compose logs waha`; probá `WAHA_ENGINE=WEBJS` en `.env` y reiniciá |
| `listar_chats` vuelve vacío | El primer sincronizado tarda unos minutos después de vincular |
| El QR se vence siempre | Pedí `vincular_numero` y escaneá enseguida; vence en menos de un minuto |
| Mensajes que no llegan | Verificá el número con `verificar_numero`; revisá el 9 en los argentinos |

## Estructura

```
docker-compose.yml       WAHA, escuchando solo en localhost
.env.example             Configuración y límites (copiar a .env)
.mcp.json                Registra el servidor MCP en Claude Code
mcp-server/
  src/config.ts          Lee el .env y valida los límites
  src/waha.ts            Cliente HTTP de WAHA y normalización de números
  src/limites.ts         Topes de envío, espera al azar y contador persistente
  src/index.ts           Las 13 herramientas MCP
  prueba/humo.mjs        Prueba de humo contra un WAHA simulado
datos/                   Sesiones de WhatsApp y contador (nunca al repo)
```
