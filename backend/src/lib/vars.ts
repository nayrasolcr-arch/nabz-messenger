// Small shared helpers for reading numeric vars.
export function intVar(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
