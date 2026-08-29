const Module = require('node:module');

const vscodeMock = {
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: (_name, fallback) => fallback })
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
