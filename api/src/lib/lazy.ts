// An object built the first time something uses it, not when its module is imported.
//
// A BullMQ Queue or QueueEvents connects its Redis client as soon as it is built, even a client
// created with lazyConnect. Built at import time, every module that imports a queue, however
// indirectly, opened a connection, so the api tests reached for a Redis they do not have. Their
// connection errors, logged while a test worker shut down, failed CI with EnvironmentTeardownError
// though every test passed. The servers use each queue at start-up, so they build it then, as
// before.
//
//   export const agentQueue = lazy(() => new Queue(...));
//
// Each property read builds the object once, then reads from it; a method keeps the object as its
// `this`.
export function lazy<T extends object>(make: () => T): T {
  let made: T | undefined;
  const target = () => (made ??= make());
  return new Proxy({} as T, {
    get(_t, prop) {
      const obj = target();
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
    set(_t, prop, value) {
      return Reflect.set(target(), prop, value);
    },
    has(_t, prop) {
      return Reflect.has(target(), prop);
    },
  });
}
