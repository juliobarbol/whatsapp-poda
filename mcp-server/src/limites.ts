import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

export class LimiteAlcanzado extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimiteAlcanzado";
  }
}

type Registro = { ts: number; numero: string; nuevo: boolean };
type Estado = { envios: Registro[]; conocidos: string[] };

const VACIO: Estado = { envios: [], conocidos: [] };

/**
 * Aplica los topes de envío y espacia los mensajes.
 *
 * Todo envío pasa por `conPermiso`, así que los límites no se pueden saltear
 * desde el chat: para aflojarlos hay que editar el .env y reiniciar el MCP.
 * Las ventanas son móviles ("las últimas 24 horas", no "hoy"), que es lo que
 * mira WhatsApp cuando decide si un número se está portando raro.
 */
export class ControlDeEnvios {
  private estado: Estado | null = null;
  private cola: Promise<unknown> = Promise.resolve();

  constructor(private readonly archivo = path.join(config.dataDir, "envios.json")) {}

  private async cargar(): Promise<Estado> {
    if (this.estado) return this.estado;
    try {
      const crudo = await fs.readFile(this.archivo, "utf8");
      const leido = JSON.parse(crudo) as Partial<Estado>;
      this.estado = {
        envios: Array.isArray(leido.envios) ? leido.envios : [],
        conocidos: Array.isArray(leido.conocidos) ? leido.conocidos : [],
      };
    } catch {
      // Primera corrida, o archivo ilegible: arrancamos de cero en vez de
      // reventar. Perder el contador afloja los límites un rato; no poder
      // mandar nada los rompe del todo.
      this.estado = { ...VACIO };
    }
    return this.estado;
  }

  private async guardar(estado: Estado): Promise<void> {
    await fs.mkdir(path.dirname(this.archivo), { recursive: true });
    const temporal = `${this.archivo}.tmp`;
    await fs.writeFile(temporal, JSON.stringify(estado), "utf8");
    await fs.rename(temporal, this.archivo);
  }

  private podar(estado: Estado, ahora: number): void {
    estado.envios = estado.envios.filter((e) => ahora - e.ts < DIA_MS);
  }

  private encolar<T>(tarea: () => Promise<T>): Promise<T> {
    const siguiente = this.cola.then(tarea, tarea);
    // La cola nunca se rompe por un envío fallido: el próximo igual corre.
    this.cola = siguiente.then(
      () => undefined,
      () => undefined,
    );
    return siguiente;
  }

  /**
   * Corre `accion` si hay cupo, después de una espera al azar.
   * Los envíos se serializan: nunca salen dos en paralelo.
   */
  async conPermiso<T>(
    numero: string,
    accion: () => Promise<T>,
  ): Promise<{ resultado: T; esperaMs: number; eraNuevo: boolean }> {
    return this.encolar(async () => {
      const estado = await this.cargar();
      const ahora = Date.now();
      this.podar(estado, ahora);

      const eraNuevo = !estado.conocidos.includes(numero);
      const ultimaHora = estado.envios.filter((e) => ahora - e.ts < HORA_MS).length;
      const ultimoDia = estado.envios.length;
      const nuevosDia = estado.envios.filter((e) => e.nuevo).length;

      if (ultimaHora >= config.limites.porHora) {
        throw new LimiteAlcanzado(
          `Tope por hora alcanzado (${ultimaHora}/${config.limites.porHora}). ` +
            `${describirEspera(estado.envios, ahora, HORA_MS)} Nada se envió.`,
        );
      }
      if (ultimoDia >= config.limites.porDia) {
        throw new LimiteAlcanzado(
          `Tope diario alcanzado (${ultimoDia}/${config.limites.porDia}). ` +
            `${describirEspera(estado.envios, ahora, DIA_MS)} Nada se envió.`,
        );
      }
      if (eraNuevo && nuevosDia >= config.limites.nuevosPorDia) {
        throw new LimiteAlcanzado(
          `Tope diario de contactos nuevos alcanzado (${nuevosDia}/${config.limites.nuevosPorDia}). ` +
            `Escribirle a muchos desconocidos seguido es lo que más rápido quema un número. ` +
            `Podés seguir respondiéndole a gente con la que ya hablaste. Nada se envió.`,
        );
      }

      const esperaMs = randomInt(config.limites.retardoMinMs, config.limites.retardoMaxMs + 1);
      await new Promise((listo) => setTimeout(listo, esperaMs));

      const resultado = await accion();

      // Recién acá se cuenta: si el envío falla, no gasta cupo.
      estado.envios.push({ ts: Date.now(), numero, nuevo: eraNuevo });
      if (eraNuevo) estado.conocidos.push(numero);
      await this.guardar(estado);

      return { resultado, esperaMs, eraNuevo };
    });
  }

  async resumen(): Promise<{
    ultimaHora: number;
    ultimoDia: number;
    nuevosUltimoDia: number;
    restanHora: number;
    restanDia: number;
    restanNuevos: number;
    contactosConocidos: number;
    limites: typeof config.limites;
  }> {
    const estado = await this.cargar();
    const ahora = Date.now();
    this.podar(estado, ahora);

    const ultimaHora = estado.envios.filter((e) => ahora - e.ts < HORA_MS).length;
    const ultimoDia = estado.envios.length;
    const nuevosUltimoDia = estado.envios.filter((e) => e.nuevo).length;

    return {
      ultimaHora,
      ultimoDia,
      nuevosUltimoDia,
      restanHora: Math.max(0, config.limites.porHora - ultimaHora),
      restanDia: Math.max(0, config.limites.porDia - ultimoDia),
      restanNuevos: Math.max(0, config.limites.nuevosPorDia - nuevosUltimoDia),
      contactosConocidos: estado.conocidos.length,
      limites: config.limites,
    };
  }
}

function describirEspera(envios: Registro[], ahora: number, ventanaMs: number): string {
  const dentro = envios.filter((e) => ahora - e.ts < ventanaMs);
  const masViejo = dentro.reduce((min, e) => Math.min(min, e.ts), Infinity);
  if (!Number.isFinite(masViejo)) return "";
  const minutos = Math.ceil((masViejo + ventanaMs - ahora) / 60_000);
  return `Se libera cupo en ~${minutos} min.`;
}
