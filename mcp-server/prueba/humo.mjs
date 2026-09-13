#!/usr/bin/env node
/**
 * Prueba de humo del servidor MCP.
 *
 * Levanta un WAHA falso, arranca el MCP contra él y verifica el circuito
 * completo: listar herramientas, enviar un mensaje, aplicar el tope por hora,
 * y rechazar un número sin código de país. No toca WhatsApp ni la red.
 *
 *   npm run prueba
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import assert from "node:assert/strict";

const aca = path.dirname(fileURLToPath(import.meta.url));
const servidorMcp = path.join(aca, "..", "dist", "index.js");

const CLAVE = "clave-de-prueba";
let enviados = [];

// --- WAHA falso ---------------------------------------------------------------

const waha = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cuerpo = await new Promise((listo) => {
    let datos = "";
    req.on("data", (c) => (datos += c));
    req.on("end", () => listo(datos ? JSON.parse(datos) : {}));
  });

  if (req.headers["x-api-key"] !== CLAVE) {
    res.writeHead(401).end(JSON.stringify({ error: "clave incorrecta" }));
    return;
  }

  const responder = (datos, codigo = 200) =>
    res.writeHead(codigo, { "Content-Type": "application/json" }).end(JSON.stringify(datos));

  const sesionActiva = {
    name: "principal",
    status: "WORKING",
    me: { id: "5491100000000@c.us", pushName: "Poda" },
    engine: { engine: "NOWEB" },
  };

  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/sessions":
      return responder([sesionActiva]);
    case "GET /api/sessions/principal":
      return responder(sesionActiva);
    case "GET /api/sessions/fantasma":
      return responder({ error: "not found" }, 404);
    case "POST /api/startTyping":
    case "POST /api/stopTyping":
      return responder({});
    case "POST /api/sendText":
      enviados.push(cuerpo);
      return responder({ id: `msg-${enviados.length}`, timestamp: Date.now() / 1000 });
    case "GET /api/contacts/check-exists":
      return responder({ numberExists: true, chatId: `${url.searchParams.get("phone")}@c.us` });
    default:
      return responder({ error: `sin ruta para ${req.method} ${url.pathname}` }, 404);
  }
});

await new Promise((listo) => waha.listen(0, "127.0.0.1", listo));
const puerto = waha.address().port;

// --- Cliente MCP mínimo --------------------------------------------------------

const datos = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-poda-prueba-"));
const mcp = spawn(process.execPath, [servidorMcp], {
  env: {
    ...process.env,
    WAHA_API_KEY: CLAVE,
    WAHA_URL: `http://127.0.0.1:${puerto}`,
    WA_SESION_DEFAULT: "principal",
    WA_DATA_DIR: datos,
    RETARDO_MIN_MS: "0",
    RETARDO_MAX_MS: "1",
    LIMITE_POR_HORA: "2",
    LIMITE_POR_DIA: "50",
    LIMITE_NUEVOS_POR_DIA: "50",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let pendientes = new Map();
let acumulado = "";
mcp.stdout.on("data", (trozo) => {
  acumulado += trozo;
  const lineas = acumulado.split("\n");
  acumulado = lineas.pop() ?? "";
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    const mensaje = JSON.parse(linea);
    const resolver = pendientes.get(mensaje.id);
    if (resolver) {
      pendientes.delete(mensaje.id);
      resolver(mensaje);
    }
  }
});

let siguienteId = 1;
function pedir(method, params) {
  const id = siguienteId++;
  const espera = new Promise((listo) => pendientes.set(id, listo));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return espera;
}
function notificar(method, params) {
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const llamar = async (name, args = {}) => {
  const r = await pedir("tools/call", { name, arguments: args });
  return { texto: (r.result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n"), crudo: r.result };
};

// --- Las pruebas ---------------------------------------------------------------

let fallas = 0;
async function caso(nombre, fn) {
  try {
    await fn();
    console.log(`  ok   ${nombre}`);
  } catch (error) {
    fallas++;
    console.log(`  FALLA ${nombre}\n       ${error.message}`);
  }
}

console.log("\nPrueba de humo del MCP de WhatsApp\n");

await pedir("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "prueba", version: "1.0.0" },
});
notificar("notifications/initialized", {});

await caso("expone todas las herramientas", async () => {
  const r = await pedir("tools/list", {});
  const nombres = r.result.tools.map((t) => t.name).sort();
  const esperadas = [
    "buscar_contacto",
    "cambiar_numero",
    "desvincular_numero",
    "enviar_archivo",
    "enviar_mensaje",
    "estado_limites",
    "estado_numero",
    "leer_mensajes",
    "listar_chats",
    "listar_numeros",
    "marcar_leido",
    "verificar_numero",
    "vincular_numero",
  ];
  assert.deepEqual(nombres, esperadas);
});

await caso("lista el número vinculado", async () => {
  const { texto } = await llamar("listar_numeros");
  assert.match(texto, /principal — WORKING — 5491100000000/);
});

await caso("envía un mensaje y normaliza el número", async () => {
  const { texto } = await llamar("enviar_mensaje", {
    destinatario: "+54 9 11 2233-4455",
    texto: "Hola, te paso el presupuesto de la poda.",
  });
  assert.match(texto, /Enviado a 5491122334455@c\.us/);
  assert.equal(enviados.at(-1).chatId, "5491122334455@c.us");
  assert.equal(enviados.at(-1).session, "principal");
});

await caso("marca el primer mensaje a un número como contacto nuevo", async () => {
  const { texto } = await llamar("enviar_mensaje", { destinatario: "5491199887766", texto: "Hola" });
  assert.match(texto, /primer mensaje a este número/);
});

await caso("corta al llegar al tope por hora", async () => {
  const { texto, crudo } = await llamar("enviar_mensaje", { destinatario: "5491155443322", texto: "Tercero" });
  assert.equal(crudo.isError, true, "debería marcarse como error");
  assert.match(texto, /Tope por hora alcanzado \(2\/2\)/);
  assert.match(texto, /Nada se envió/);
  assert.equal(enviados.length, 2, "no debería haber salido un tercer mensaje");
});

await caso("rechaza un número sin código de país", async () => {
  const { texto, crudo } = await llamar("enviar_mensaje", { destinatario: "1122-3344", texto: "Hola" });
  assert.equal(crudo.isError, true);
  assert.match(texto, /código de país/);
});

await caso("avisa cuando la sesión no existe", async () => {
  const { texto, crudo } = await llamar("listar_chats", { sesion: "fantasma" });
  assert.equal(crudo.isError, true);
  assert.match(texto, /No existe la sesión "fantasma"/);
});

await caso("verificar_numero no gasta cupo", async () => {
  const { texto } = await llamar("verificar_numero", { telefono: "5491133224455" });
  assert.match(texto, /tiene WhatsApp/);
  const cupo = await llamar("estado_limites");
  assert.match(cupo.texto, /Última hora:  2\/2/);
});

await caso("el contador de envíos persiste en disco", async () => {
  const guardado = JSON.parse(await fs.readFile(path.join(datos, "envios.json"), "utf8"));
  assert.equal(guardado.envios.length, 2);
  assert.equal(guardado.conocidos.length, 2);
});

mcp.kill();
waha.close();
await fs.rm(datos, { recursive: true, force: true });

console.log(fallas === 0 ? "\nTodo bien.\n" : `\n${fallas} falla(s).\n`);
process.exit(fallas === 0 ? 0 : 1);
