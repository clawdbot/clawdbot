"use strict";

const stub = new Proxy(
  function pluginSdkStub() {
    return stub;
  },
  {
    apply() {
      return stub;
    },
    construct() {
      return stub;
    },
    get(_target, prop) {
      if (prop === "__esModule") {
        return true;
      }
      if (prop === "default") {
        return stub;
      }
      if (prop === "then") {
        return undefined;
      }
      if (prop === Symbol.toPrimitive) {
        return () => "";
      }
      if (prop === "toJSON") {
        return () => undefined;
      }
      if (prop === "toString") {
        return () => "";
      }
      if (prop === "valueOf") {
        return () => 0;
      }
      return stub;
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), "__esModule", "default"])];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "__esModule") {
        return {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false,
        };
      }
      if (prop === "default") {
        return {
          configurable: true,
          enumerable: false,
          value: stub,
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  },
);

module.exports = stub;
