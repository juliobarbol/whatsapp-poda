import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Raíz del proyecto: dos niveles arriba de dist/config.js.
const raiz = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Cargamos el .env nosotros para que la configuración de Claude no necesite
// llevar la clave de la API, y para que funcione sin importar desde dónde
// se haya arrancado el proceso.
const rutaEnv = path.join(raiz, ".env");
if (existsSync(rutaEnv)) process.loadEnvFile(rutaEnv);

function entero(nombre: string, porDefecto: number): number {
  const bruto = process.env[nombre];
  if (bruto === undefined || bruto.trim() === "") return porDefecto;
  const valor = Number(bruto);
  if (!Number.isInteger(valor) || valor < 0) {
    throw new Error(`${nombre} debe ser un entero >= 0, llegó "${bruto}"`);
  }
  return valor;
}

const retardoMinMs = entero("RETARDO_MIN_MS", 8_000);
const retardoMaxMs = entero("RETARDO_MAX_MS", 25_000);
if (retardoMinMs > retardoMaxMs) {
  throw new Error(
    `RETARDO_MIN_MS (${retardoMinMs}) no puede ser mayor que RETARDO_MAX_MS (${retardoMaxMs})`,
  );
}

const apiKey = process.env.WAHA_API_KEY?.trim() ?? "";
if (apiKey === "") {
  throw new Error(
    "Falta WAHA_API_KEY. Copiá .env.example a .env y generá una clave con: openssl rand -hex 24",
  );
}

export const config = {
  wahaUrl: (process.env.WAHA_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
  apiKey,
  sesionDefault: process.env.WA_SESION_DEFAULT?.trim() || "principal",
  // Relativo a la raíz del proyecto, no al directorio desde donde se arrancó.
  dataDir: path.resolve(raiz, process.env.WA_DATA_DIR?.trim() || "./datos"),
  limites: {
    porHora: entero("LIMITE_POR_HORA", 20),
    porDia: entero("LIMITE_POR_DIA", 100),
    // Bajo a propósito: el manual de outreach fija 1–2 mensajes en frío por
    // día, y ya hubo una restricción de WhatsApp en esta cuenta.
    nuevosPorDia: entero("LIMITE_NUEVOS_POR_DIA", 3),
    retardoMinMs,
    retardoMaxMs,
    // Verificar no manda mensajes, pero consultar muchos números seguidos
    // también es una señal de automatización, así que tiene su propio freno.
    verificacionPorMinuto: entero("LIMITE_VERIFICACION_POR_MINUTO", 20),
    verificacionPorDia: entero("LIMITE_VERIFICACION_POR_DIA", 300),
    verificacionPorTanda: entero("LIMITE_VERIFICACION_POR_TANDA", 50),
    verificacionRetardoMinMs: entero("VERIFICACION_RETARDO_MIN_MS", 1_000),
    verificacionRetardoMaxMs: entero("VERIFICACION_RETARDO_MAX_MS", 3_000),
  },
} as const;

if (config.limites.verificacionRetardoMinMs > config.limites.verificacionRetardoMaxMs) {
  throw new Error(
    `VERIFICACION_RETARDO_MIN_MS (${config.limites.verificacionRetardoMinMs}) no puede ser mayor ` +
      `que VERIFICACION_RETARDO_MAX_MS (${config.limites.verificacionRetardoMaxMs})`,
  );
}

export type Config = typeof config;
