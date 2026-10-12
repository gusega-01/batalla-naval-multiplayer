/** Clon profundo. El estado del juego es JSON puro (sin Map/Set/Date), así que alcanza y funciona en cualquier runtime. */
export const deepClone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
