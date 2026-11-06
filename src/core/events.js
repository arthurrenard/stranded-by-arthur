// Tiny synchronous event bus. Event names and payloads are listed in SPEC.md §Events.
export function createEvents() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name)?.delete(fn);
    },
    once(name, fn) {
      const off = this.on(name, (p) => {
        off();
        fn(p);
      });
      return off;
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (e) {
          console.error(`[events] handler for "${name}" threw`, e);
        }
      }
    },
  };
}
