/**
 * Low-level numeric helpers for the deterministic risk engine.
 * Pure functions only.
 */

/**
 * Inverse of the standard normal CDF (quantile function).
 * Peter Acklam's rational approximation; absolute error < 1.15e-9,
 * which is far below anything that matters for a risk bound.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`inverseNormalCdf requires 0 < p < 1, got ${p}`);
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Build a covariance matrix from vols and a correlation matrix. */
export function covarianceFromCorrelation(
  vols: number[],
  corr: number[][],
): number[][] {
  const n = vols.length;
  assertSquare(corr, n, "correlation matrix");
  const cov: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      const rho = corr[i]![j]!;
      if (rho < -1 || rho > 1) {
        throw new RangeError(`correlation [${i}][${j}] = ${rho} outside [-1, 1]`);
      }
      if (i === j && Math.abs(rho - 1) > 1e-9) {
        throw new RangeError(`correlation diagonal [${i}][${i}] must be 1, got ${rho}`);
      }
      row.push(rho * vols[i]! * vols[j]!);
    }
    cov.push(row);
  }
  return cov;
}

/** w' * M * w for a square matrix M. */
export function quadraticForm(w: number[], m: number[][]): number {
  const n = w.length;
  assertSquare(m, n, "matrix");
  let acc = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      acc += w[i]! * m[i]![j]! * w[j]!;
    }
  }
  return acc;
}

/** Matrix–vector product M * w. */
export function matVec(m: number[][], w: number[]): number[] {
  const n = w.length;
  assertSquare(m, n, "matrix");
  return m.map((row) => row.reduce((acc, v, j) => acc + v * w[j]!, 0));
}

function assertSquare(m: number[][], n: number, label: string): void {
  if (m.length !== n || m.some((row) => row.length !== n)) {
    throw new RangeError(`${label} must be ${n}x${n}`);
  }
}
