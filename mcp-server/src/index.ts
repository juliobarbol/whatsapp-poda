#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { ControlDeEnvios, LimiteAlcanzado } from "./limites.js";
import {
  ClienteWaha,
  ErrorWaha,
  normalizarChatId,
  numeroDe,
  separarEtiquetaYNumero,
  variantesDelNumero,
  type ChatWaha,
  type MensajeWaha,
  type SesionWaha,
} from "./waha.js";

const waha = new ClienteWaha();
const control = new ControlDeEnvios();

const servidor = new McpServer({ name: "whatsapp-poda", version: "1.0.0" });

const sesionOpcional = z
  .string()
  .optional()
  .describe(
    `Nombre del número a usar. Si no lo aclarás se usa "${config.sesionDefault}". ` +
      `Cada número vinculado es una sesión con su propio nombre.`,
  );

const dormir = (ms: number) => new Promise((listo) => setTimeout(listo, ms));

type Contenido =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Convierte los errores esperables (WAHA caído, número mal escrito, tope de
 * envíos) en una respuesta legible en vez de un stack trace.
 */
function herramienta<A extends z.ZodRawShape>(
  nombre: string,
  meta: { title: string; description: string; inputSchema: A },
  manejador: (args: z.objectOutputType<A, z.ZodTypeAny>) => Promise<Contenido[]>,
) {
  servidor.registerTool(nombre, meta, (async (args: z.objectOutputType<A, z.ZodTypeAny>) => {
    try {
      return { content: await manejador(args) };
    } catch (error) {
      const esperado = error instanceof ErrorWaha || error instanceof LimiteAlcanzado;
      if (!esperado) console.error(`[whatsapp-poda] fallo en ${nombre}:`, error);
      return {
        content: [
          { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
        ],
        isError: true,
      };
    }
  }) as never);
}

const texto = (t: string): Contenido[] => [{ type: "text", text: t }];

function sesionDe(args: { sesion?: string }): string {
  return args.sesion?.trim() || config.sesionDefault;
}

function describirSesion(s: SesionWaha): string {
  const numero = s.me?.id ? numeroDe(s.me.id) : "sin vincular";
  const nombre = s.me?.pushName ? ` (${s.me.pushName})` : "";
  return `• ${s.name} — ${s.status} — ${numero}${nombre}`;
}

async function exigirActiva(sesion: string): Promise<void> {
  let estado: SesionWaha;
  try {
    estado = await waha.obtenerSesion(sesion);
  } catch (error) {
    if (error instanceof ErrorWaha && error.status === 404) {
      throw new ErrorWaha(
        `No existe la sesión "${sesion}". Vinculá un número con vincular_numero, ` +
          `o mirá cuáles hay con listar_numeros.`,
      );
    }
    throw error;
  }
  if (estado.status !== "WORKING") {
    throw new ErrorWaha(
      `La sesión "${sesion}" está en estado ${estado.status}, no se puede operar. ` +
        (estado.status === "SCAN_QR_CODE"
          ? "Falta escanear el QR: usá vincular_numero."
          : "Probá vincular_numero para reactivarla."),
    );
  }
}

/** Espera a que la sesión salga de STARTING y devuelve su estado final. */
async function esperarEstado(sesion: string, intentos = 15): Promise<SesionWaha> {
  let ultima = await waha.obtenerSesion(sesion);
  for (let i = 0; i < intentos && (ultima.status === "STARTING" || ultima.status === "STOPPED"); i++) {
    await dormir(1_500);
    ultima = await waha.obtenerSesion(sesion);
  }
  return ultima;
}

/** Arranca la sesión si hace falta y devuelve el QR, o avisa que ya está lista. */
async function vincular(sesion: string): Promise<Contenido[]> {
  let estado: SesionWaha | null = null;
  try {
    estado = await waha.obtenerSesion(sesion);
  } catch (error) {
    if (!(error instanceof ErrorWaha) || error.status !== 404) throw error;
  }

  if (!estado) {
    await waha.crearSesion(sesion);
  } else if (estado.status === "STOPPED" || estado.status === "FAILED") {
    await waha.iniciarSesion(sesion);
  }

  const final = await esperarEstado(sesion);

  if (final.status === "WORKING") {
    const numero = final.me?.id ? numeroDe(final.me.id) : "número desconocido";
    return texto(`La sesión "${sesion}" ya está vinculada al ${numero}. No hace falta escanear nada.`);
  }
  if (final.status !== "SCAN_QR_CODE") {
    return texto(
      `La sesión "${sesion}" quedó en estado ${final.status}. ` +
        `Revisá los logs con: docker compose logs -f waha`,
    );
  }

  const qr = await waha.qr(sesion);
  return [
    {
      type: "text",
      text:
        `Escaneá este QR para vincular el número a la sesión "${sesion}".\n\n` +
        `En el celular: WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo.\n` +
        `El QR vence en menos de un minuto; si se vence, pedime vincular_numero de nuevo.`,
    },
    { type: "image", data: qr.data, mimeType: qr.mimetype || "image/png" },
  ];
}

// --- Gestión de números ------------------------------------------------------

herramienta(
  "listar_numeros",
  {
    title: "Listar números vinculados",
    description:
      "Muestra todas las sesiones de WhatsApp configuradas, su estado y a qué número está vinculada cada una. " +
      "Usalo para saber con qué números se puede operar.",
    inputSchema: {},
  },
  async () => {
    const sesiones = await waha.listarSesiones();
    if (sesiones.length === 0) {
      return texto("No hay ningún número vinculado todavía. Usá vincular_numero para empezar.");
    }
    return texto(
      `Números configurados (por defecto se usa "${config.sesionDefault}"):\n` +
        sesiones.map(describirSesion).join("\n"),
    );
  },
);

herramienta(
  "vincular_numero",
  {
    title: "Vincular un número (QR)",
    description:
      "Arranca una sesión y devuelve el QR para escanear desde el celular. " +
      "Sirve tanto para el primer número como para agregar uno nuevo en paralelo: " +
      'pasale un nombre distinto, por ejemplo "secundario", y quedan los dos disponibles.',
    inputSchema: { sesion: sesionOpcional },
  },
  async (args) => vincular(sesionDe(args)),
);

herramienta(
  "cambiar_numero",
  {
    title: "Cambiar el número de una sesión",
    description:
      "Desvincula el número actual de una sesión y devuelve un QR nuevo para vincular otro en su lugar. " +
      "El historial de esa cuenta deja de estar accesible. " +
      "Si en vez de reemplazarlo querés tener los dos a mano, usá vincular_numero con otro nombre de sesión.",
    inputSchema: { sesion: sesionOpcional },
  },
  async (args) => {
    const sesion = sesionDe(args);
    let anterior = "el número anterior";
    try {
      const estado = await waha.obtenerSesion(sesion);
      if (estado.me?.id) anterior = numeroDe(estado.me.id);
      await waha.cerrarSesion(sesion);
    } catch (error) {
      if (!(error instanceof ErrorWaha) || error.status !== 404) throw error;
    }
    await dormir(1_500);
    const resultado = await vincular(sesion);
    return [
      { type: "text", text: `Desvinculé ${anterior} de la sesión "${sesion}".` },
      ...resultado,
    ];
  },
);

herramienta(
  "desvincular_numero",
  {
    title: "Desvincular un número",
    description:
      "Cierra la sesión de WhatsApp y borra sus credenciales del servidor, sin vincular ninguna otra. " +
      "Equivale a cerrar el dispositivo vinculado desde el celular.",
    inputSchema: { sesion: sesionOpcional },
  },
  async (args) => {
    const sesion = sesionDe(args);
    await waha.cerrarSesion(sesion);
    return texto(
      `Sesión "${sesion}" desvinculada. Para volver a usarla, vincular_numero y escaneás el QR.`,
    );
  },
);

herramienta(
  "estado_numero",
  {
    title: "Estado de un número",
    description: "Dice si una sesión está lista para operar y a qué número está vinculada.",
    inputSchema: { sesion: sesionOpcional },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const estado = await waha.obtenerSesion(sesion);
    return texto(
      `${describirSesion(estado)}\nMotor: ${estado.engine?.engine ?? "desconocido"}\n` +
        (estado.status === "WORKING" ? "Lista para enviar y leer." : "No operativa todavía."),
    );
  },
);

// --- Envío -------------------------------------------------------------------

herramienta(
  "enviar_mensaje",
  {
    title: "Enviar un mensaje de texto",
    description:
      "Manda un mensaje de WhatsApp. Espera unos segundos al azar y simula tipeo antes de enviar, " +
      "y respeta los topes por hora, por día y de contactos nuevos configurados en el .env. " +
      "Si un tope está alcanzado no envía nada y te avisa cuánto falta para que se libere cupo.",
    inputSchema: {
      destinatario: z
        .string()
        .describe(
          "Número con código de país y sin +, por ejemplo 5491122334455, o un chatId como 5491122334455@c.us. " +
            "En Argentina va el 9 después del 54.",
        ),
      texto: z.string().min(1).describe("El contenido del mensaje."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const chatId = normalizarChatId(args.destinatario);
    await exigirActiva(sesion);

    const { esperaMs, eraNuevo } = await control.conPermiso(numeroDe(chatId), async () => {
      await waha.escribiendo(sesion, chatId, true);
      await dormir(Math.min(8_000, Math.max(1_200, args.texto.length * 60)));
      await waha.escribiendo(sesion, chatId, false);
      return waha.enviarTexto(sesion, chatId, args.texto);
    });

    const cupo = await control.resumen();
    return texto(
      `Enviado a ${chatId}${eraNuevo ? " (primer mensaje a este número)" : ""}, ` +
        `después de esperar ${Math.round(esperaMs / 1000)} s.\n` +
        `Cupo restante: ${cupo.restanHora} esta hora, ${cupo.restanDia} hoy, ` +
        `${cupo.restanNuevos} contactos nuevos.`,
    );
  },
);

herramienta(
  "enviar_archivo",
  {
    title: "Enviar una imagen o un archivo",
    description:
      "Manda una foto o un documento (presupuesto, factura, foto del trabajo) desde una URL pública. " +
      "Cuenta contra los mismos topes que enviar_mensaje.",
    inputSchema: {
      destinatario: z.string().describe("Número con código de país sin +, o chatId."),
      url: z.string().url().describe("URL pública del archivo. WAHA la descarga para enviarla."),
      nombre_archivo: z.string().optional().describe("Nombre con el que llega, por ejemplo presupuesto.pdf"),
      mimetype: z.string().optional().describe("Tipo MIME, por ejemplo application/pdf o image/jpeg."),
      epigrafe: z.string().optional().describe("Texto que acompaña al archivo."),
      como_imagen: z
        .boolean()
        .optional()
        .describe("true para que se vea como foto en el chat; false para mandarlo como documento adjunto."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const chatId = normalizarChatId(args.destinatario);
    await exigirActiva(sesion);

    const { esperaMs } = await control.conPermiso(numeroDe(chatId), () =>
      waha.enviarArchivo(
        sesion,
        chatId,
        { url: args.url, filename: args.nombre_archivo, mimetype: args.mimetype },
        { caption: args.epigrafe, comoImagen: args.como_imagen ?? false },
      ),
    );

    const cupo = await control.resumen();
    return texto(
      `Archivo enviado a ${chatId} después de esperar ${Math.round(esperaMs / 1000)} s.\n` +
        `Cupo restante: ${cupo.restanHora} esta hora, ${cupo.restanDia} hoy.`,
    );
  },
);

// --- Lectura -----------------------------------------------------------------

herramienta(
  "listar_chats",
  {
    title: "Listar conversaciones recientes",
    description: "Trae las conversaciones más recientes con su último mensaje.",
    inputSchema: {
      limite: z.number().int().min(1).max(100).optional().describe("Cuántas conversaciones traer (por defecto 20)."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    await exigirActiva(sesion);
    const chats = await waha.resumenChats(sesion, args.limite ?? 20);
    if (chats.length === 0) return texto("No hay conversaciones para mostrar.");
    return texto(chats.map(describirChat).join("\n"));
  },
);

herramienta(
  "leer_mensajes",
  {
    title: "Leer mensajes de una conversación",
    description: "Trae los mensajes más recientes de un chat, del más viejo al más nuevo.",
    inputSchema: {
      chat: z.string().describe("Número con código de país sin +, o chatId (incluye grupos con @g.us)."),
      limite: z.number().int().min(1).max(200).optional().describe("Cuántos mensajes traer (por defecto 20)."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const chatId = normalizarChatId(args.chat);
    await exigirActiva(sesion);
    const mensajes = await waha.mensajes(sesion, chatId, args.limite ?? 20);
    if (mensajes.length === 0) return texto(`No hay mensajes en ${chatId}.`);
    const ordenados = [...mensajes].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return texto(`Mensajes de ${chatId}:\n\n${ordenados.map(describirMensaje).join("\n")}`);
  },
);

herramienta(
  "marcar_leido",
  {
    title: "Marcar una conversación como leída",
    description: "Pone en visto los mensajes pendientes de un chat.",
    inputSchema: {
      chat: z.string().describe("Número con código de país sin +, o chatId."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const chatId = normalizarChatId(args.chat);
    await exigirActiva(sesion);
    await waha.marcarLeido(sesion, chatId);
    return texto(`${chatId} marcado como leído.`);
  },
);

// --- Contactos ---------------------------------------------------------------

herramienta(
  "verificar_numero",
  {
    title: "Verificar si un número tiene WhatsApp",
    description:
      "Dice si un número está registrado en WhatsApp, sin mandarle nada y sin gastar cupo de envío. " +
      "Útil para limpiar una lista de leads antes de escribirles.",
    inputSchema: {
      telefono: z.string().describe("Número con código de país y sin +, por ejemplo 5491122334455."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    const telefono = args.telefono.replace(/\D/g, "");
    if (telefono.length < 10) {
      throw new ErrorWaha(`"${args.telefono}" no parece un número completo. Incluí el código de país.`);
    }
    await exigirActiva(sesion);
    const hallazgo = await verificarConVariantes(sesion, telefono);
    if (!hallazgo) return texto(`${telefono} NO tiene WhatsApp (puede ser un fijo).`);
    return texto(
      `${hallazgo.numero} tiene WhatsApp. chatId: ${hallazgo.chatId}` +
        (hallazgo.corregido ? `\nOjo: el número que pasaste no funcionaba; le agregué el 9 de Argentina.` : ""),
    );
  },
);

herramienta(
  "verificar_numeros_en_tanda",
  {
    title: "Verificar una lista de números",
    description:
      "Revisa una lista de contactos y dice cuáles tienen WhatsApp, sin mandarles nada. " +
      "Pensado para limpiar una planilla de leads antes de escribir: acepta líneas pegadas de una " +
      "columna, tipo 'Vivero Los Álamos: +54 351 456-7890'. " +
      "A los números argentinos que fallan les prueba también la forma con el 9, que es como los " +
      "publica Google Maps. Va despacio a propósito y no gasta cupo de envío.",
    inputSchema: {
      contactos: z
        .array(z.string().min(3))
        .min(1)
        .describe(
          "Una entrada por contacto. Puede ser el número solo o 'Nombre: número'. " +
            "Los repetidos se descartan.",
        ),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    await exigirActiva(sesion);

    const conWhatsapp: string[] = [];
    const corregidos: string[] = [];
    const sinWhatsapp: string[] = [];
    const invalidos: string[] = [];
    // `vistos` solo sirve para no repetir contactos; los efectivamente
    // consultados se cuentan aparte, porque el tope por tanda deja algunos afuera.
    const vistos = new Set<string>();
    let revisados = 0;

    for (const entrada of args.contactos) {
      const partido = separarEtiquetaYNumero(entrada);
      if (!partido) {
        invalidos.push(`${entrada.trim()} — no encontré un número acá`);
        continue;
      }
      const { etiqueta, digitos } = partido;
      const nombre = etiqueta || digitos;

      if (digitos.length < 10) {
        invalidos.push(`${nombre} (${digitos}) — le falta el código de país`);
        continue;
      }
      if (vistos.has(digitos)) continue;
      vistos.add(digitos);

      if (revisados >= config.limites.verificacionPorTanda) {
        invalidos.push(
          `${nombre} — no lo revisé: la tanda corta en ${config.limites.verificacionPorTanda} números. ` +
            `Mandá el resto en otra tanda.`,
        );
        continue;
      }

      const hallazgo = await verificarConVariantes(sesion, digitos);
      revisados++;
      if (!hallazgo) {
        sinWhatsapp.push(`${nombre} — ${digitos}`);
      } else if (hallazgo.corregido) {
        corregidos.push(`${nombre} — ${hallazgo.numero} (pasaste ${digitos})`);
      } else {
        conWhatsapp.push(`${nombre} — ${hallazgo.numero}`);
      }
    }

    const cupo = await control.resumen();
    const partes: string[] = [
      `Revisé ${revisados} número(s): ` +
        `${conWhatsapp.length + corregidos.length} con WhatsApp, ${sinWhatsapp.length} sin, ` +
        `${invalidos.length} con problemas.`,
    ];

    if (conWhatsapp.length > 0) {
      partes.push(`\nCON WHATSAPP (${conWhatsapp.length}) — listos para escribir:\n${lista(conWhatsapp)}`);
    }
    if (corregidos.length > 0) {
      partes.push(
        `\nCORREGIDOS (${corregidos.length}) — tienen WhatsApp con el 9 agregado.\n` +
          `Actualizá el número en la planilla, el viejo no abre chat:\n${lista(corregidos)}`,
      );
    }
    if (sinWhatsapp.length > 0) {
      partes.push(
        `\nSIN WHATSAPP (${sinWhatsapp.length}) — probablemente fijos.\n` +
          `Para estos conviene llamar o buscar el celular en Instagram:\n${lista(sinWhatsapp)}`,
      );
    }
    if (invalidos.length > 0) {
      partes.push(`\nNO PUDE REVISAR (${invalidos.length}):\n${lista(invalidos)}`);
    }

    partes.push(
      `\nQuedan ${cupo.restanVerificaciones} verificaciones hoy.\n` +
        `Tener el número validado no es lo mismo que poder escribirle a todos: ` +
        `el tope de contactos nuevos sigue en ${cupo.limites.nuevosPorDia} por día, ` +
        `y hoy quedan ${cupo.restanNuevos}.`,
    );

    return texto(partes.join("\n"));
  },
);

herramienta(
  "buscar_contacto",
  {
    title: "Buscar un contacto",
    description: "Busca en la agenda de la cuenta por nombre o por número, sin distinguir mayúsculas.",
    inputSchema: {
      consulta: z.string().min(2).describe("Parte del nombre o del número a buscar."),
      sesion: sesionOpcional,
    },
  },
  async (args) => {
    const sesion = sesionDe(args);
    await exigirActiva(sesion);
    const consulta = args.consulta.toLowerCase().trim();
    const soloDigitos = consulta.replace(/\D/g, "");
    const contactos = await waha.contactos(sesion, 1_000);

    const coincidencias = contactos.filter((c) => {
      const nombre = `${c.name ?? ""} ${c.pushname ?? ""}`.toLowerCase();
      if (nombre.includes(consulta)) return true;
      return soloDigitos.length >= 4 && (c.number ?? "").includes(soloDigitos);
    });

    if (coincidencias.length === 0) return texto(`Sin resultados para "${args.consulta}".`);
    return texto(
      `${coincidencias.length} resultado(s) para "${args.consulta}":\n` +
        coincidencias
          .slice(0, 40)
          .map((c) => `• ${c.name || c.pushname || "sin nombre"} — ${c.number ?? c.id}`)
          .join("\n"),
    );
  },
);

// --- Control de envíos --------------------------------------------------------

herramienta(
  "estado_limites",
  {
    title: "Ver el cupo de envíos",
    description:
      "Muestra cuántos mensajes se enviaron en la última hora y en las últimas 24 h, y cuánto cupo queda. " +
      "Consultalo antes de encarar una tanda de mensajes.",
    inputSchema: {},
  },
  async () => {
    const r = await control.resumen();
    return texto(
      [
        `Última hora:  ${r.ultimaHora}/${r.limites.porHora} enviados — quedan ${r.restanHora}`,
        `Últimas 24 h: ${r.ultimoDia}/${r.limites.porDia} enviados — quedan ${r.restanDia}`,
        `Contactos nuevos en 24 h: ${r.nuevosUltimoDia}/${r.limites.nuevosPorDia} — quedan ${r.restanNuevos}`,
        `Verificaciones en 24 h: ${r.verificacionesUltimoDia}/${r.limites.verificacionPorDia} — quedan ${r.restanVerificaciones}`,
        `Espera entre envíos: ${r.limites.retardoMinMs / 1000}–${r.limites.retardoMaxMs / 1000} s al azar`,
        `Números a los que ya les escribiste alguna vez: ${r.contactosConocidos}`,
        "",
        "Las ventanas son móviles: cuentan hacia atrás desde ahora, no desde medianoche.",
        "Para cambiar los topes, editá el .env y reiniciá el MCP.",
      ].join("\n"),
    );
  },
);

// --- Auxiliares ---------------------------------------------------------------

/**
 * Consulta si un número tiene WhatsApp, probando también la forma argentina
 * con el 9 si la primera no da. Devuelve null si ninguna variante existe.
 */
async function verificarConVariantes(
  sesion: string,
  digitos: string,
): Promise<{ numero: string; chatId: string; corregido: boolean } | null> {
  const variantes = variantesDelNumero(digitos);
  for (const [indice, variante] of variantes.entries()) {
    const respuesta = await control.conPermisoVerificacion(() => waha.verificarNumero(sesion, variante));
    if (respuesta.numberExists) {
      return {
        numero: variante,
        chatId: respuesta.chatId ?? `${variante}@c.us`,
        corregido: indice > 0,
      };
    }
  }
  return null;
}

const lista = (renglones: string[]): string => renglones.map((r) => `  • ${r}`).join("\n");

// --- Arranque -----------------------------------------------------------------

function describirChat(c: ChatWaha): string {
  const quien = c.name || c.id || "sin nombre";
  const ultimo = c.lastMessage?.body?.replace(/\s+/g, " ").slice(0, 80);
  const marca = c.lastMessage?.fromMe ? "vos: " : "";
  return `• ${quien} (${c.id ?? "?"})${ultimo ? ` — ${marca}${ultimo}` : ""}`;
}

function describirMensaje(m: MensajeWaha): string {
  const cuando = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString("es-AR") : "sin fecha";
  const quien = m.fromMe ? "vos" : (m.from ?? "?");
  const cuerpo = m.body?.trim() || (m.hasMedia ? "[archivo adjunto]" : "[sin texto]");
  return `[${cuando}] ${quien}: ${cuerpo}`;
}

async function principal(): Promise<void> {
  // stdout es el canal del protocolo MCP: cualquier log va a stderr.
  console.error(
    `[whatsapp-poda] WAHA en ${config.wahaUrl}, sesión por defecto "${config.sesionDefault}", ` +
      `topes ${config.limites.porHora}/h y ${config.limites.porDia}/día.`,
  );
  await servidor.connect(new StdioServerTransport());
}

principal().catch((error) => {
  console.error("[whatsapp-poda] no pudo arrancar:", error);
  process.exit(1);
});
