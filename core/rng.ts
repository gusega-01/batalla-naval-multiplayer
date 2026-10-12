/**
 * RNG determinista y reproducible: (seed, counter) → misma secuencia.
 *  - La semilla vive SOLO en el servidor (o en el dispositivo en modo offline). Nunca se envía a clientes.
 *  - sfc32 con 128 bits de estado. No es criptográfico: si algún día te preocupa un oponente que intente
 *    predecir la ruleta a partir de resultados observados, genera la semilla con crypto y rota la semilla
 *    por partida (ya es así) o inyecta crypto.randomInt para la ruleta.
 *  - Es isomórfico: no importa nada de Node.
 */
import type { RngState } from './types';

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Semilla de 128 bits; usa crypto si el runtime lo tiene (Node 19+, navegadores, Hermes recientes). */
export function newSeed(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) {
    return Array.from(c.getRandomValues(new Uint32Array(4)), (x) => x.toString(16).padStart(8, '0')).join('');
  }
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 4294967296).toString(16).padStart(8, '0')).join('');
}

/** Envuelve un RngState: cada valor consumido incrementa state.counter (así queda reproducible). */
export class Rng {
  private readonly gen: () => number;

  constructor(private readonly st: RngState) {
    const [a, b, c, d] = cyrb128(st.seed);
    this.gen = sfc32(a, b, c, d);
    for (let i = 0; i < 12 + st.counter; i++) this.gen(); // calentamiento + reposición hasta counter
  }

  float(): number {
    this.st.counter += 1;
    return this.gen();
  }
  int(n: number): number {
    return Math.floor(this.float() * n);
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
