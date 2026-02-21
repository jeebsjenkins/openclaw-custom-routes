const fs = require('fs');
const path = require('path');

const REQUIRED_EXPORTS = ['path', 'method', 'handler'];

class RouteLoader {
  constructor(routesDir, logger) {
    this.routesDir = routesDir;
    this.log = logger;
    this.routes = new Map();
  }

  /**
   * Scan the routes directory and load all valid route modules.
   * Returns an array of route definitions.
   */
  scan() {
    if (!fs.existsSync(this.routesDir)) {
      this.log.warn(`Routes directory not found: ${this.routesDir}`);
      return [];
    }

    const discovered = new Map();
    this._scanDir(this.routesDir, '', discovered);

    // Detect added and removed routes
    const added = [];
    const removed = [];

    for (const [file, route] of discovered) {
      if (!this.routes.has(file)) {
        added.push(file);
      }
    }
    for (const file of this.routes.keys()) {
      if (!discovered.has(file)) {
        removed.push(file);
      }
    }

    if (added.length) this.log.info(`Routes added: ${added.join(', ')}`);
    if (removed.length) this.log.info(`Routes removed: ${removed.join(', ')}`);

    this.routes = discovered;
    return Array.from(discovered.values());
  }

  /**
   * Recursively scan a directory for .js route files.
   * prefix is the path segment derived from subfolder structure (e.g. '/api').
   */
  _scanDir(dir, prefix, discovered) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        this._scanDir(path.join(dir, entry.name), `${prefix}/${entry.name}`, discovered);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const relFile = prefix ? `${prefix.slice(1)}/${entry.name}` : entry.name;
        const route = this._loadModule(path.join(dir, entry.name), prefix, relFile);
        if (route) {
          discovered.set(relFile, route);
        }
      }
    }
  }

  /**
   * Load a single route module, clearing the require cache so changes
   * are picked up without a restart.
   */
  _loadModule(filePath, prefix, relFile) {
    try {
      // Clear require cache for hot-reload
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);

      for (const key of REQUIRED_EXPORTS) {
        if (!(key in mod)) {
          this.log.warn(`Route ${relFile} missing required export "${key}" — skipped`);
          return null;
        }
      }

      const method = mod.method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        this.log.warn(`Route ${relFile} has unsupported method "${mod.method}" — skipped`);
        return null;
      }

      return {
        file: relFile,
        path: prefix + mod.path,
        method,
        handler: mod.handler,
        description: mod.description || '',
      };
    } catch (err) {
      this.log.error(`Failed to load route ${relFile}: ${err.message}`);
      return null;
    }
  }

  /**
   * Return the currently loaded routes as a summary (for diagnostics).
   */
  list() {
    return Array.from(this.routes.values()).map(r => ({
      method: r.method.toUpperCase(),
      path: r.path,
      file: r.file,
      description: r.description,
    }));
  }
}

module.exports = RouteLoader;
