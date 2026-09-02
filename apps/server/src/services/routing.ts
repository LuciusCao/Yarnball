/**
 * 顺路算法（纯函数，不碰 IO，可单测）。
 * 输入一律是「时长矩阵」duration[i][j]（秒），i===j 为 0；
 * 无 API 时调用方可以传直线距离换算的矩阵。
 */

/** 最近邻初始解 */
export function nearestNeighbor(matrix: number[][]): number[] {
  const n = matrix.length;
  if (n <= 1) return [...Array(n).keys()];
  const visited = new Set<number>([0]);
  const order = [0];
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      const cost = matrix[last][j];
      if (Number.isFinite(cost) && cost < bestCost) {
        bestCost = cost;
        best = j;
      }
    }
    if (best === -1) {
      // 矩阵有洞（某个点互相不可达）：按原顺序补位
      for (let j = 0; j < n; j++) {
        if (!visited.has(j)) {
          best = j;
          break;
        }
      }
    }
    order.push(best);
    visited.add(best);
  }
  return order;
}

/** 2-opt 迭代改进（固定起点，即从第一个点出发不回头） */
export function twoOpt(order: number[], matrix: number[][]): number[] {
  const n = order.length;
  if (n <= 2) return [...order];

  const pathCost = (o: number[]): number => {
    let sum = 0;
    for (let i = 0; i + 1 < o.length; i++) {
      const c = matrix[o[i]][o[i + 1]];
      if (!Number.isFinite(c)) return Infinity;
      sum += c;
    }
    return sum;
  };

  let best = [...order];
  let bestCost = pathCost(best);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 100) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const cost = pathCost(candidate);
        if (cost < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }
  return best;
}

export function orderTotalDuration(order: number[], matrix: number[][]): number {
  let sum = 0;
  for (let i = 0; i + 1 < order.length; i++) sum += matrix[order[i]][order[i + 1]];
  return sum;
}

/**
 * 重排建议：保留 Day 的第一个点作为起点（通常是用户定的集合点/早餐），
 * 优化其余点的顺序。
 */
export function optimizeOrder(matrix: number[][]): number[] {
  if (matrix.length <= 2) return [...Array(matrix.length).keys()];
  const initial = nearestNeighbor(matrix);
  const optimized = twoOpt(initial, matrix);
  // 优化过程不动下标 0（起点）
  return optimized[0] === 0 ? optimized : optimized;
}

/**
 * 插入分析：在长度为 n 的链路里，把新点插到每个位置的开销增量。
 * 返回 increment[k] = duration[prev→new] + duration[new→next] - duration[prev→next]
 * k=0 表示插在最前（没有 prev），k=n 表示插在最后。
 */
export function insertionIncrements(
  chain: number[],
  newIdx: number,
  matrix: number[][],
): { position: number; incrementS: number }[] {
  const results: { position: number; incrementS: number }[] = [];
  const n = chain.length;
  for (let k = 0; k <= n; k++) {
    const prev = k > 0 ? chain[k - 1] : null;
    const next = k < n ? chain[k] : null;
    let inc = 0;
    if (prev !== null) inc += matrix[prev][newIdx];
    if (next !== null) inc += matrix[newIdx][next];
    if (prev !== null && next !== null) inc -= matrix[prev][next];
    results.push({ position: k, incrementS: Number.isFinite(inc) ? inc : Number.MAX_SAFE_INTEGER });
  }
  return results;
}
