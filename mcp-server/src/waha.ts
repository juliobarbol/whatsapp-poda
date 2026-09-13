import { config } from "./config.js";

export class ErrorWaha extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ErrorWaha";
  }
}

/**
 * Convierte lo que escriba el usuario en un chatId de WhatsApp.
 *
 * Acepta un chatId ya armado ("5491122334455@c.us", un grupo "@g.us") o un
 * número suelto con o sin +, espacios y guiones. Exige el código de país:
 * mandarle un mensaje al desconocido equivocado no se deshace, así que ante
 * la duda corta en vez de adivinar.
 */
export function normalizarChatId(entrada: string): string {
  const limpio = entrada.trim();
  if (/@(c\.us|g\.us|lid|newsletter)$/i.test(limpio)) return limpio;

  const digitos = limpio.replace(/\D/g, "");
  if (digitos.length < 10) {
    throw new ErrorWaha(
      `"${entrada}" no parece un número completo. Incluí el código de país sin el +, ` +
        `por ejemplo 5491122334455 para un celular de Buenos Aires.`,
    );
  }
  if (digitos.length > 15) {
    throw new ErrorWaha(`"${entrada}" tiene ${digitos.length} dígitos, demasiados para un número válido.`);
  }
  return `${digitos}@c.us`;
}

/** Los dígitos del destinatario, para llevar la cuenta de envíos. */
export function numeroDe(chatId: string): string {
  return chatId.split("@")[0] ?? chatId;
}

type Peticion = {
  metodo?: "GET" | "POST" | "PUT" | "DELETE";
  cuerpo?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

export class ClienteWaha {
  constructor(
    private readonly baseUrl = config.wahaUrl,
    private readonly apiKey = config.apiKey,
  ) {}

  private async pedir<T>(ruta: string, { metodo = "GET", cuerpo, query }: Peticion = {}): Promise<T> {
    const url = new URL(this.baseUrl + ruta);
    for (const [clave, valor] of Object.entries(query ?? {})) {
      if (valor !== undefined) url.searchParams.set(clave, String(valor));
    }

    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        method: metodo,
        headers: {
          "X-Api-Key": this.apiKey,
          Accept: "application/json",
          ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (causa) {
      throw new ErrorWaha(
        `No se pudo contactar a WAHA en ${this.baseUrl}. ¿Está levantado? Probá: docker compose ps. ` +
          `(${causa instanceof Error ? causa.message : String(causa)})`,
      );
    }

    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new ErrorWaha(
        `WAHA respondió ${respuesta.status} en ${metodo} ${ruta}: ${texto.slice(0, 400)}`,
        respuesta.status,
      );
    }
    if (texto === "") return undefined as T;
    try {
      return JSON.parse(texto) as T;
    } catch {
      return texto as T;
    }
  }

  // --- Sesiones (un número vinculado = una sesión) ---------------------------

  listarSesiones(): Promise<SesionWaha[]> {
    return this.pedir<SesionWaha[]>("/api/sessions", { query: { all: true } });
  }

  obtenerSesion(sesion: string): Promise<SesionWaha> {
    return this.pedir<SesionWaha>(`/api/sessions/${encodeURIComponent(sesion)}`);
  }

  crearSesion(sesion: string): Promise<SesionWaha> {
    return this.pedir<SesionWaha>("/api/sessions", {
      metodo: "POST",
      cuerpo: { name: sesion, start: true },
    });
  }

  iniciarSesion(sesion: string): Promise<SesionWaha> {
    return this.pedir<SesionWaha>(`/api/sessions/${encodeURIComponent(sesion)}/start`, {
      metodo: "POST",
    });
  }

  cerrarSesion(sesion: string): Promise<void> {
    return this.pedir<void>(`/api/sessions/${encodeURIComponent(sesion)}/logout`, {
      metodo: "POST",
    });
  }

  eliminarSesion(sesion: string): Promise<void> {
    return this.pedir<void>(`/api/sessions/${encodeURIComponent(sesion)}`, { metodo: "DELETE" });
  }

  cuenta(sesion: string): Promise<CuentaWaha | null> {
    return this.pedir<CuentaWaha | null>(`/api/sessions/${encodeURIComponent(sesion)}/me`);
  }

  /** QR de vinculación en base64, listo para mostrar como imagen. */
  qr(sesion: string): Promise<{ mimetype: string; data: string }> {
    return this.pedir(`/api/${encodeURIComponent(sesion)}/auth/qr`);
  }

  // --- Mensajería ------------------------------------------------------------

  enviarTexto(sesion: string, chatId: string, texto: string): Promise<MensajeWaha> {
    return this.pedir<MensajeWaha>("/api/sendText", {
      metodo: "POST",
      cuerpo: { session: sesion, chatId, text: texto },
    });
  }

  enviarArchivo(
    sesion: string,
    chatId: string,
    archivo: { url: string; filename?: string; mimetype?: string },
    opciones: { caption?: string; comoImagen?: boolean } = {},
  ): Promise<MensajeWaha> {
    const ruta = opciones.comoImagen ? "/api/sendImage" : "/api/sendFile";
    return this.pedir<MensajeWaha>(ruta, {
      metodo: "POST",
      cuerpo: {
        session: sesion,
        chatId,
        file: archivo,
        ...(opciones.caption ? { caption: opciones.caption } : {}),
      },
    });
  }

  escribiendo(sesion: string, chatId: string, activo: boolean): Promise<void> {
    return this.pedir<void>(activo ? "/api/startTyping" : "/api/stopTyping", {
      metodo: "POST",
      cuerpo: { session: sesion, chatId },
    });
  }

  marcarLeido(sesion: string, chatId: string): Promise<void> {
    return this.pedir<void>("/api/sendSeen", {
      metodo: "POST",
      cuerpo: { session: sesion, chatId },
    });
  }

  // --- Lectura ---------------------------------------------------------------

  resumenChats(sesion: string, limit: number, offset = 0): Promise<ChatWaha[]> {
    return this.pedir<ChatWaha[]>(`/api/${encodeURIComponent(sesion)}/chats/overview`, {
      query: { limit, offset },
    });
  }

  mensajes(sesion: string, chatId: string, limit: number): Promise<MensajeWaha[]> {
    return this.pedir<MensajeWaha[]>(
      `/api/${encodeURIComponent(sesion)}/chats/${encodeURIComponent(chatId)}/messages`,
      { query: { limit, downloadMedia: false } },
    );
  }

  verificarNumero(sesion: string, telefono: string): Promise<{ numberExists: boolean; chatId?: string }> {
    return this.pedir("/api/contacts/check-exists", {
      query: { session: sesion, phone: telefono },
    });
  }

  contacto(sesion: string, contactId: string): Promise<ContactoWaha> {
    return this.pedir<ContactoWaha>("/api/contacts", {
      query: { session: sesion, contactId },
    });
  }

  contactos(sesion: string, limit: number, offset = 0): Promise<ContactoWaha[]> {
    return this.pedir<ContactoWaha[]>("/api/contacts/all", {
      query: { session: sesion, limit, offset, sortBy: "name", sortOrder: "asc" },
    });
  }
}

// --- Formas de respuesta que efectivamente usamos ----------------------------

export type SesionWaha = {
  name: string;
  status: string;
  me?: CuentaWaha | null;
  engine?: { engine?: string };
};

export type CuentaWaha = { id?: string; pushName?: string };

export type MensajeWaha = {
  id?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  hasMedia?: boolean;
  _data?: unknown;
};

export type ChatWaha = {
  id?: string;
  name?: string;
  picture?: string | null;
  lastMessage?: MensajeWaha | null;
};

export type ContactoWaha = {
  id?: string;
  number?: string;
  name?: string;
  pushname?: string;
  isWAContact?: boolean;
  isMyContact?: boolean;
};
