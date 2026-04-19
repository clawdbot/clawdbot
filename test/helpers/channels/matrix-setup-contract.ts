import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type MatrixContractSurface = {
  matrixSetupAdapter: Record<string, unknown>;
  matrixSetupWizard: Record<string, unknown>;
};

let matrixContractSurface: MatrixContractSurface | undefined;

function createLazyObjectSurface<T extends object>(loadSurface: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const surface = loadSurface();
      const value = Reflect.get(surface, property, surface);
      return typeof value === "function" ? value.bind(surface) : value;
    },
    has(_target, property) {
      return property in loadSurface();
    },
    ownKeys() {
      return Reflect.ownKeys(loadSurface());
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(loadSurface(), property);
    },
  });
}

function getMatrixContractSurface(): MatrixContractSurface {
  matrixContractSurface ??= loadBundledPluginContractApiSync<MatrixContractSurface>("matrix");
  return matrixContractSurface;
}

export const matrixSetupAdapter = createLazyObjectSurface(
  () => getMatrixContractSurface().matrixSetupAdapter,
);

export const matrixSetupWizard = createLazyObjectSurface(
  () => getMatrixContractSurface().matrixSetupWizard,
);
