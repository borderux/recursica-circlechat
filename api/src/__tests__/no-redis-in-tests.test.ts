import { describe, it, expect } from "vitest";

// The api tests run with no Redis. A module that builds a BullMQ Queue or QueueEvents when it is
// imported makes BullMQ connect the shared client at once, and its connection errors, logged while
// a test worker shuts down, failed CI with `EnvironmentTeardownError: Closing rpc while
// "onUserConsoleLog" was pending` though every test passed. Importing a module must open no
// connection; only a call that uses a queue may.

describe("importing the api's modules opens no Redis connection", () => {
  it("the queues are built only when something uses them", async () => {
    const { redis, pub, sub } = await import("../lib/redis.js");
    // tasks-core reaches the agent queue through enqueue; the other two queues are imported directly.
    await import("../lib/tasks-core.js");
    await import("../agents/queue.js");
    await import("../lib/workflow-queue.js");
    await import("../lib/goal-queue.js");
    await new Promise((r) => setTimeout(r, 100));
    for (const client of [redis, pub, sub]) expect(client.status).toBe("wait");
  });
});

describe("lazy", () => {
  it("builds nothing until first use, builds once, and keeps the object as a method's this", async () => {
    const { lazy } = await import("../lib/lazy.js");
    let built = 0;
    class Counter {
      n = 0;
      add(k: number) { this.n += k; return this; }
    }
    const c = lazy(() => { built++; return new Counter(); });
    expect(built).toBe(0);
    c.add(2);
    const add = c.add;
    add(3);
    expect(c.n).toBe(5);
    expect("add" in c).toBe(true);
    c.n = 9;
    expect(c.n).toBe(9);
    expect(built).toBe(1);
  });
});
