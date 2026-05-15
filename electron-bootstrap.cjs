const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const entryUrl = pathToFileURL(resolve(__dirname, "dist-electron/main.js")).href;

import(entryUrl).catch((error) => {
  console.error("[desktop] failed to import Electron main entry");
  console.error(error);
  process.exit(1);
});
