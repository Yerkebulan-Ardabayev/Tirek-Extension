/**
 * Очередь с троттлингом для демпинг-запросов (spec раздел 5 «Масштаб», анти-бан).
 *
 * Демпинг — дорогой запрос (1 на товар). У крупного магазина сотни SKU. Наивно
 * дёрнуть все сразу = бан Kaspi. Поэтому:
 *   - последовательная очередь (concurrency 1-2),
 *   - пауза с джиттером между запросами (~1-2с),
 *   - экспоненциальный бэкофф на 429/403,
 *   - приоритет (watchlist + есть себестоимость + дороже — первыми),
 *   - дневной потолок запросов (превышение НЕ молчим, а возвращаем dropped),
 *   - возможность поставить на паузу / отменить.
 *
 * Таймер и rng инъектируются — очередь детерминированно тестируется без
 * реального ожидания.
 */

/** Ошибка, сигнализирующая, что запрос можно повторить (429/403/сеть). */
export class RetryableError extends Error {
  constructor(
    message: string,
    /** HTTP-статус, если известен (429/403). */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/** Является ли ошибка повторяемой (для бэкоффа). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  // Иногда статус приходит как свойство обычной ошибки.
  const status = (err as { status?: number } | null)?.status;
  return status === 429 || status === 403;
}

export type ThrottleTask<R> = {
  /** Уникальный ключ (например SKU). */
  key: string;
  /** Приоритет: больше — раньше. */
  priority: number;
  /** Асинхронная работа. Бросает RetryableError на 429/403. */
  run: () => Promise<R>;
};

/** Внешнее управление паузой/отменой (мутируемый объект). */
export class ThrottleController {
  paused = false;
  cancelled = false;
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

export type ThrottleOptions = {
  /** Сколько задач параллельно. По умолчанию 1 (рекомендуется для анти-бана). */
  concurrency?: number;
  /** Базовая пауза между стартами задач, мс. По умолчанию 1500. */
  minDelayMs?: number;
  /** Случайная добавка к паузе 0..jitterMs, мс. По умолчанию 700. */
  jitterMs?: number;
  /** Сколько раз повторять на RetryableError. По умолчанию 3. */
  maxRetries?: number;
  /** База экспоненциального бэкоффа, мс. По умолчанию 2000. */
  backoffBaseMs?: number;
  /** Дневной потолок числа задач. Превышение возвращается как dropped. */
  dailyCap?: number;
  /** Инъекция сна (для тестов). По умолчанию setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Инъекция rng 0..1 (для тестов). По умолчанию Math.random. */
  rng?: () => number;
  /** Внешнее управление паузой/отменой. */
  controller?: ThrottleController;
  /** Колбэк на каждый успешный результат (для инкрементального UI). */
  onResult?: (key: string, value: unknown) => void;
  /** Колбэк на ошибку задачи (после исчерпания повторов). */
  onError?: (key: string, error: unknown) => void;
  /** Колбэк прогресса (done из total). */
  onProgress?: (done: number, total: number) => void;
};

export type ThrottleRunResult<R> = {
  results: Array<{ key: string; value: R }>;
  errors: Array<{ key: string; error: string }>;
  /** Успешно выполнено. */
  completed: number;
  /** Не запущено из-за дневного потолка (НЕ молчим про обрезку). */
  dropped: number;
  /** Прервано по cancel. */
  cancelled: boolean;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Задержка перед стартом задачи: база + джиттер. */
export function throttleDelay(minDelayMs: number, jitterMs: number, rng: () => number): number {
  return minDelayMs + Math.floor(rng() * Math.max(0, jitterMs));
}

/** Бэкофф перед повтором: backoffBase × 2^attempt + джиттер. */
export function backoffDelay(
  attempt: number,
  backoffBaseMs: number,
  jitterMs: number,
  rng: () => number,
): number {
  const expo = backoffBaseMs * Math.pow(2, attempt);
  return expo + Math.floor(rng() * Math.max(0, jitterMs));
}

/**
 * Приоритет демпинга по правилам spec раздел 5:
 * сначала watchlist и товары с заданной себестоимостью (важны селлеру),
 * потом — самые дорогие. Возвращает число (больше = раньше).
 */
export function dempingPriority(opts: {
  inWatchlist?: boolean;
  hasCost?: boolean;
  price?: number;
}): number {
  const flags = (opts.inWatchlist ? 2 : 0) + (opts.hasCost ? 1 : 0); // 0..3
  // price < 1e9 (Kaspi cap 50 млн), поэтому флаги доминируют над ценой.
  const price = Math.min(Math.max(opts.price ?? 0, 0), 999_999_999);
  return flags * 1_000_000_000 + price;
}

/**
 * Запускает задачи с троттлингом, бэкоффом, приоритетом и паузой/отменой.
 */
export async function runThrottled<R>(
  tasks: ThrottleTask<R>[],
  opts: ThrottleOptions = {},
): Promise<ThrottleRunResult<R>> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const minDelayMs = opts.minDelayMs ?? 1500;
  const jitterMs = opts.jitterMs ?? 700;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 2000;
  const dailyCap = opts.dailyCap ?? Infinity;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const controller = opts.controller ?? new ThrottleController();

  // Приоритет: по убыванию (стабильно для равных).
  const ordered = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .map((x) => x.t);

  const capped = Number.isFinite(dailyCap) ? ordered.slice(0, dailyCap) : ordered;
  const dropped = ordered.length - capped.length;

  const results: Array<{ key: string; value: R }> = [];
  const errors: Array<{ key: string; error: string }> = [];
  let nextIndex = 0;
  let done = 0;
  const total = capped.length;

  async function waitWhilePaused(): Promise<void> {
    while (controller.paused && !controller.cancelled) {
      await sleep(minDelayMs);
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (controller.cancelled) return;
      await waitWhilePaused();
      if (controller.cancelled) return;

      const myIndex = nextIndex++;
      if (myIndex >= capped.length) return;
      const task = capped[myIndex];
      if (!task) return;

      // Троттл перед запросом.
      await sleep(throttleDelay(minDelayMs, jitterMs, rng));
      if (controller.cancelled) return;

      let attempt = 0;
      for (;;) {
        try {
          const value = await task.run();
          results.push({ key: task.key, value });
          opts.onResult?.(task.key, value);
          break;
        } catch (err) {
          if (isRetryable(err) && attempt < maxRetries && !controller.cancelled) {
            await sleep(backoffDelay(attempt, backoffBaseMs, jitterMs, rng));
            attempt++;
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ key: task.key, error: msg });
          opts.onError?.(task.key, err);
          break;
        }
      }

      done++;
      opts.onProgress?.(done, total);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, capped.length) }, () => worker());
  await Promise.all(workers);

  return {
    results,
    errors,
    completed: results.length,
    dropped,
    cancelled: controller.cancelled,
  };
}
