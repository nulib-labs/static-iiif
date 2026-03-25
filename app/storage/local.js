const fs = require("fs/promises");
const path = require("path");

class LocalStorage {
  constructor({ root }) {
    if (!root) {
      throw new Error("LocalStorage requires a root directory");
    }
    this.root = root;
    this.kind = "local";
  }

  resolveKey(key) {
    return path.join(this.root, ...key.split("/"));
  }

  async writeBinary(key, buffer) {
    const target = this.resolveKey(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return target;
  }

  async writeJson(key, payload) {
    const json = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return this.writeBinary(key, Buffer.from(json));
  }
}

module.exports = { LocalStorage };
