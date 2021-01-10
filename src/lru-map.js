/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */

const promiseTimeout = function (ms, v) {
  // Create a promise that rejects in <ms> milliseconds
  const timeout = new Promise((resolve, reject) => {
    const id = setTimeout(() => reject("Timed out in " + ms + "ms."), ms);
  });

  // Returns a race between our timeout and the passed in promise
  return Promise.race([Promise.resolve(v), timeout]);
};

class LRUMap {
  constructor(opts = {}) {
    this._maxSize = opts.maxSize != null ? opts.maxSize : Infinity;
    this._maxAge = opts.maxAge != null ? opts.maxAge : Infinity;
    this._calcSize = opts.calcSize != null ? opts.calcSize : (value) => 1;
    this._user_onEvict =
      opts.onEvict != null ? opts.onEvict : (key, value) => undefined;
    this._user_onStale =
      opts.onStale != null ? opts.onStale : (key, value) => undefined;
    this._onRemove =
      opts.onRemove != null ? opts.onRemove : (key, value) => undefined;
    this._accessUpdatesTimestamp =
      opts.accessUpdatesTimestamp != null ? opts.accessUpdatesTimestamp : false;
    this._warmer =
      opts.warmer != null ? opts.warmer : (cache) => Promise.resolve();

    if (typeof this._maxSize !== "number" || !(this._maxSize >= 0)) {
      throw new Error("maxSize must be a non-negative number");
    }

    if (typeof this._calcSize !== "function") {
      throw new TypeError("calcSize must be a function");
    }

    if (typeof this._user_onEvict !== "function") {
      throw new TypeError("onEvict must be a function");
    }

    if (typeof this._user_onStale !== "function") {
      throw new TypeError("onStale must be a function");
    }

    if (typeof this._onRemove !== "function") {
      throw new TypeError("onRemove must be a function");
    }

    if (typeof this._warmer !== "function") {
      throw new TypeError("warmer must be a function");
    }

    this._onEvict = (key, value) => {
      this._onRemove(key, value);
      return this._user_onEvict(key, value);
    };

    this._onStale = (key, value) => {
      this._onRemove(key, value);
      return this._user_onStale(key, value);
    };

    this._atomicInflights = new Map();
    this._map = new Map();
    this._total = 0;

    this[Symbol.iterator] = function () {
      return this.entries();
    };

    if (LRUMap.__testing__ === true) {
      this.testMap = this._map;
      this.testInflights = this._atomicInflights;
      this.getTestMap = () => this._map;
      this.testSetTotal = (x) => {
        return (this._total = x);
      };
      this.testSetMaxAge = (x) => {
        return (this._maxAge = x);
      };
    }
  }

  // immediate effect; reaps stales
  maxAge(age) {
    if (age != null) {
      if (typeof age !== "number" || !(age > 0)) {
        throw new Error("age must be a positive number of seconds");
      }

      this._maxAge = age;

      this.reapStale();
    }

    return this._maxAge;
  }

  // no immediate effect
  accessUpdatesTimestamp(doesIt) {
    if (doesIt != null) {
      if (typeof doesIt !== "boolean") {
        throw new TypeError("accessUpdatesTimestamp accepts a boolean");
      }

      this._accessUpdatesTimestamp = doesIt;
    }

    return this._accessUpdatesTimestamp;
  }

  // immediate effect; reaps stales
  maxSize(size) {
    if (size != null) {
      if (typeof size !== "number" || !(size > 0)) {
        throw new Error("size must be a positive number");
      }

      this._maxSize = size;

      this.reapStale();

      const entries = this._map.entries();
      while (this._total > this._maxSize) {
        const oldest = entries.next().value;

        if (oldest == null) {
          break;
        }

        this._map.delete(oldest[0]);
        this._total -= oldest[1].size;

        this._onEvict(oldest[0], oldest[1].value);
      }
    }

    return this._maxSize;
  }

  // returns a promise that will be fulfilled when the cache is done warming
  warm() {
    if (this._warmed == null) {
      this._warmed = Promise.resolve(this._warmer(this));
    }
    return this._warmed;
  }

  // non-mutating; idempotent
  currentSize() {
    return this._total;
  }

  // non-mutating; idempotent
  fits(value) {
    return this._calcSize(value) <= this._maxSize;
  }

  // non-mutating; idempotent
  wouldCauseEviction(value) {
    return (
      this._calcSize(value) + this._total > this._maxSize && this._total > 0
    );
  }

  // non-mutating configuration method; no immediate effect
  onEvict(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("argument to onEvict must be a function");
    }

    return (this._onEvict = fn);
  }

  // non-mutating configuration method; no immediate effect
  onStale(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("argument to onStale must be a function");
    }

    return (this._onStale = fn);
  }

  // non-mutating configuration method; no immediate effect
  onRemove(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("argument to onRemove must be a function");
    }

    return (this._onRemove = fn);
  }

  // reaps stales
  reapStale() {
    if (this._maxAge === Infinity) {
      return;
    }

    const entries = this._map.entries();
    let cur = entries.next().value;

    return (() => {
      const result = [];
      while (cur != null) {
        const diff = (+new Date() - cur[1].timestamp) / 1000;

        if (diff > this._maxAge) {
          this._map.delete(cur[0]);
          this._total -= cur[1].size;

          this._onStale(cur[0], cur[1].value);
        } else {
          if (this._accessUpdatesTimestamp) {
            break;
          }
        }

        result.push((cur = entries.next().value));
      }
      return result;
    })();
  }

  // mutates Map state; affects LRU eviction; affects staleness; reaps stales
  set(key, value) {
    this.reapStale();

    const size = this._calcSize(value);
    const timestamp = +new Date();
    let priorTotal = this._total;

    if (isNaN(size) || size < 0 || typeof size !== "number") {
      throw new Error("calcSize() must return a positive number");
    }

    if (this._map.has(key)) {
      priorTotal -= this.sizeOf(key);
    }

    if (size > this._maxSize) {
      throw new Error(
        `cannot store an object of that size (maxSize = ${this._maxSize}; value size = ${size})`
      );
    }

    const entries = this._map.entries();

    while (priorTotal + size > this._maxSize) {
      const oldest = entries.next().value;

      if (oldest == null) {
        break;
      }

      this._map.delete(oldest[0]);
      priorTotal -= oldest[1].size;

      this._onEvict(oldest[0], oldest[1].value);
    }

    this._map.set(key, { size, value, timestamp });
    this._total = priorTotal + size;

    return this;
  }

  // mutates Map state; affects LRU eviction; affects staleness; reaps stales
  setIfNull(key, newValue, opts) {
    if (opts == null) {
      opts = {};
    }
    if (typeof opts !== "object") {
      throw new TypeError("opts must be an object");
    }

    if (opts.timeout == null) {
      opts.timeout = 10000;
    }
    if (opts.invokeNewValueFunction == null) {
      opts.invokeNewValueFunction = true;
    }
    if (opts.onCacheHit == null) {
      opts.onCacheHit = () => undefined;
    }
    if (opts.onCacheMiss == null) {
      opts.onCacheMiss = () => undefined;
    }

    if (typeof opts.timeout !== "number" || !(opts.timeout >= 1)) {
      throw new TypeError(
        "opts.timeout must be a positive number (possibly Infinity)"
      );
    }

    if (typeof opts.invokeNewValueFunction !== "boolean") {
      throw new TypeError("opts.invokeNewValueFunction must be boolean");
    }

    if (typeof opts.onCacheHit !== "function") {
      throw new TypeError("opts.onCacheHit must be a function");
    }

    if (typeof opts.onCacheMiss !== "function") {
      throw new TypeError("opts.onCacheMiss must be a function");
    }

    if (this._atomicInflights.has(key)) {
      setTimeout(() => opts.onCacheHit(key));
      return this._atomicInflights.get(key);
    }

    this.reapStale();

    if (this._map.has(key)) {
      setTimeout(() => opts.onCacheHit(key));
      return Promise.resolve(this.get(key));
    }

    setTimeout(() => opts.onCacheMiss(key));

    if (opts.invokeNewValueFunction && typeof newValue === "function") {
      newValue = newValue();
    }

    const inflight = promiseTimeout(opts.timeout, newValue)
      .then((value) => {
        this._atomicInflights.delete(key);
        this.reapStale();
        this.set(key, value);
        return value;
      })
      .catch((e) => {
        this._atomicInflights.delete(key);
        return Promise.reject(e);
      });

    this._atomicInflights.set(key, inflight);
    return inflight;
  }

  // mutates Map state; affects LRU eviction; affects staleness; reaps stales
  delete(key) {
    if (this._map.has(key)) {
      this._total -= this.sizeOf(key);
      this._map.delete(key);
      this.reapStale();
      return true;
    } else {
      this.reapStale();
      return false;
    }
  }

  // mutates Map state
  clear() {
    this._map.clear();
    this._total = 0;
  }

  // affects LRU eviction; affects staleness if accessUpdatesTimestamp; reaps stales
  get(key) {
    this.reapStale();
    const entry = this._map.get(key);

    if (entry == null) {
      return;
    }

    this._map.delete(key);

    if (this._accessUpdatesTimestamp) {
      entry.timestamp = +new Date();
    }

    this._map.set(key, entry);

    return entry.value;
  }

  // non-evicting; reaps stales
  has(key) {
    this.reapStale();
    return this._map.has(key);
  }

  // non-evicting; reaps stales
  peek(key) {
    this.reapStale();
    const entry = this._map.get(key);
    return entry != null ? entry.value : undefined;
  }

  // non-mutating; idempotent
  sizeOf(key) {
    const entry = this._map.get(key);
    return entry != null ? entry.size : undefined;
  }

  // non-mutating; idempotent
  ageOf(key) {
    const entry = this._map.get(key);

    if (entry != null) {
      return Math.round((+new Date() - entry.timestamp) / 1000);
    }
  }

  // non-mutating; idempotent
  isStale(key) {
    const entry = this._map.get(key);

    if (entry != null) {
      return this.ageOf(key) > this._maxAge;
    }
  }

  // non-evicting; reaps stales
  keys() {
    this.reapStale();
    return this._map.keys();
  }

  // non-evicting; reaps stales
  values() {
    this.reapStale();
    const iter = this._map.values();

    return {
      next: () => {
        const ev = iter.next().value;

        if (ev != null) {
          if (this._accessUpdatesTimestamp) {
            ev.timestamp = +new Date();
          }

          return { value: ev.value, done: false };
        }

        return { done: true };
      },
    };
  }

  // non-evicting; reaps stales
  entries() {
    this.reapStale();
    const iter = this._map.entries();

    return {
      next: () => {
        const entry = iter.next().value;

        if (entry != null) {
          if (this._accessUpdatesTimestamp) {
            entry[1].timestamp = +new Date();
          }

          return { done: false, value: [entry[0], entry[1].value] };
        } else {
          return { done: true };
        }
      },
    };
  }

  // non-evicting; reaps stales
  forEach(callback, thisArg) {
    this.reapStale();
    this._map.forEach((value, key, map) => {
      if (this._accessUpdatesTimestamp) {
        value.timestamp = +new Date();
      }

      return callback.call(thisArg, value.value, key, this);
    });
  }
};

module.exports = {
  LRUMap,
};
