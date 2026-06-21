import { describe, it, expect } from "vitest";
import {
  RetryableError,
  ThrottleController,
  backoffDelay,
  dempingPriority,
  isRetryable,
  runThrottled,
  throttleDelay,
  type ThrottleTask,
} from "../lib/throttle-queue";

// Детерминированные инъекции: сон мгновенный, без джиттера.
const noSleep = async () => {};
const zeroRng = () => 0;

function task<R>(key: string, priority: number, run: () => Promise<R>): ThrottleTask<R> {
  return { key, priority, run };
}

describe("throttleDelay / backoffDelay — чистая математика", () => {
  it("throttleDelay = база + floor(rng × jitter)", () => {
    expect(throttleDelay(1500, 700, () => 0)).toBe(1500);
    expect(throttleDelay(1500, 700, () => 0.999)).toBe(1500 + 699);
  });
  it("backoffDelay растёт экспоненциально", () => {
    expect(backoffDelay(0, 2000, 0, zeroRng)).toBe(2000);
    expect(backoffDelay(1, 2000, 0, zeroRng)).toBe(4000);
    expect(backoffDelay(2, 2000, 0, zeroRng)).toBe(8000);
  });
});

describe("isRetryable", () => {
  it("RetryableError → true", () => {
    expect(isRetryable(new RetryableError("429", 429))).toBe(true);
  });
  it("обычная ошибка со status 429/403 → true", () => {
    expect(isRetryable(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { status: 403 }))).toBe(true);
  });
  it("обычная ошибка → false", () => {
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
});

describe("dempingPriority — порядок по spec", () => {
  it("watchlist важнее, чем есть-себестоимость", () => {
    const a = dempingPriority({ inWatchlist: true, price: 1 });
    const b = dempingPriority({ hasCost: true, price: 999999 });
    expect(a).toBeGreaterThan(b);
  });
  it("при равных флагах дороже — раньше", () => {
    const a = dempingPriority({ hasCost: true, price: 5000 });
    const b = dempingPriority({ hasCost: true, price: 1000 });
    expect(a).toBeGreaterThan(b);
  });
  it("оба флага > один флаг", () => {
    const both = dempingPriority({ inWatchlist: true, hasCost: true, price: 0 });
    const one = dempingPriority({ inWatchlist: true, price: 999999999 });
    expect(both).toBeGreaterThan(one);
  });
});

describe("runThrottled — порядок и результаты", () => {
  it("выполняет в порядке приоритета (concurrency 1)", async () => {
    const order: string[] = [];
    const tasks = [
      task("low", 1, async () => (order.push("low"), "L")),
      task("high", 3, async () => (order.push("high"), "H")),
      task("mid", 2, async () => (order.push("mid"), "M")),
    ];
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng });
    expect(order).toEqual(["high", "mid", "low"]);
    expect(res.completed).toBe(3);
    expect(res.results.find((r) => r.key === "high")?.value).toBe("H");
  });

  it("вызывает onResult и onProgress инкрементально", async () => {
    const progress: Array<[number, number]> = [];
    const seen: string[] = [];
    const tasks = [task("a", 1, async () => "A"), task("b", 1, async () => "B")];
    await runThrottled(tasks, {
      sleep: noSleep,
      rng: zeroRng,
      onResult: (k) => seen.push(k),
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(progress[progress.length - 1]).toEqual([2, 2]);
  });
});

describe("runThrottled — повторы и бэкофф", () => {
  it("повторяет RetryableError и в итоге успешно", async () => {
    let calls = 0;
    const tasks = [
      task("flaky", 1, async () => {
        calls++;
        if (calls < 3) throw new RetryableError("429", 429);
        return "ok";
      }),
    ];
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, maxRetries: 3 });
    expect(calls).toBe(3);
    expect(res.completed).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it("исчерпание повторов → ошибка записана", async () => {
    let calls = 0;
    const tasks = [
      task("dead", 1, async () => {
        calls++;
        throw new RetryableError("429", 429);
      }),
    ];
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, maxRetries: 2 });
    expect(calls).toBe(3); // 1 + 2 повтора
    expect(res.completed).toBe(0);
    expect(res.errors[0]?.key).toBe("dead");
  });

  it("неповторяемая ошибка не ретраится", async () => {
    let calls = 0;
    const tasks = [
      task("boom", 1, async () => {
        calls++;
        throw new Error("logic error");
      }),
    ];
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, maxRetries: 5 });
    expect(calls).toBe(1);
    expect(res.errors[0]?.error).toContain("logic error");
  });
});

describe("runThrottled — дневной потолок (без молчаливой обрезки)", () => {
  it("выполняет только cap, остальное в dropped", async () => {
    const order: string[] = [];
    const tasks = [5, 4, 3, 2, 1].map((p) =>
      task("t" + p, p, async () => (order.push("t" + p), p)),
    );
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, dailyCap: 2 });
    expect(res.completed).toBe(2);
    expect(res.dropped).toBe(3);
    expect(order).toEqual(["t5", "t4"]); // топ-2 по приоритету
  });
});

describe("runThrottled — отмена и пауза", () => {
  it("cancel прекращает обработку оставшихся", async () => {
    const order: string[] = [];
    const controller = new ThrottleController();
    const tasks = [
      task("a", 3, async () => {
        order.push("a");
        controller.cancel();
        return "A";
      }),
      task("b", 2, async () => (order.push("b"), "B")),
      task("c", 1, async () => (order.push("c"), "C")),
    ];
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, controller });
    expect(order).toEqual(["a"]);
    expect(res.cancelled).toBe(true);
  });

  it("пауза заставляет ждать, resume продолжает", async () => {
    const controller = new ThrottleController();
    controller.pause();
    let sleeps = 0;
    // через 3 «сна» снимаем паузу — иначе ждали бы вечно
    const sleep = async () => {
      sleeps++;
      if (sleeps >= 3) controller.resume();
    };
    let ran = false;
    const tasks = [task("x", 1, async () => ((ran = true), "X"))];
    const res = await runThrottled(tasks, { sleep, rng: zeroRng, controller });
    expect(ran).toBe(true);
    expect(res.completed).toBe(1);
    expect(sleeps).toBeGreaterThanOrEqual(3);
  });
});

describe("C5: dailyCap и отмена в бэкоффе", () => {
  it("отрицательный dailyCap → ничего не запускаем (всё в dropped), не slice(0,-1)", async () => {
    const tasks: ThrottleTask<number>[] = [1, 2, 3].map((n) => ({
      key: String(n),
      priority: n,
      run: async () => n,
    }));
    const res = await runThrottled(tasks, { sleep: noSleep, rng: zeroRng, dailyCap: -1 });
    expect(res.completed).toBe(0);
    expect(res.dropped).toBe(3);
  });

  it("отмена во время бэкофф-сна не даёт лишнего запроса (run ровно 1)", async () => {
    let runs = 0;
    let sleepCalls = 0;
    const controller = new ThrottleController();
    const task: ThrottleTask<number> = {
      key: "x",
      priority: 1,
      run: async () => {
        runs++;
        throw new RetryableError("429", 429);
      },
    };
    const sleep = async () => {
      sleepCalls++;
      if (sleepCalls >= 2) controller.cancel(); // 1-й сон = троттл, 2-й = бэкофф
    };
    await runThrottled([task], { sleep, rng: zeroRng, controller, maxRetries: 3 });
    expect(runs).toBe(1);
  });
});
