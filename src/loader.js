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

    const files = fs.readdirSync(this.routesDir).filter(f => f.endsWith('.js'));
    const discovered = new Map();

    for (const file of files) {
      const route = this._loadModule(file);
      if (route) {
        discovered.set(file, route);
      }
    }

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
   * Load a single route module, clearing the require cache so changes
   * are picked up without a restart.
   */
  _loadModule(file) {
    const filePath = path.join(this.routesDir, file);
    try {
      // Clear require cache for hot-reload
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);

      for (const key of REQUIRED_EXPORTS) {
        if (!(key in mod)) {
          this.log.warn(`Route ${file} missing required export "${key}" — skipped`);
          return null;
        }
      }

      const method = mod.method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        this.log.warn(`Route ${file} has unsupported method "${mod.method}" — skipped`);
        return null;
      }

      return {
        file,
        path: mod.path,
        method,
        handler: mod.handler,
        description: mod.description || '',
      };
    } catch (err) {
      this.log.error(`Failed to load route ${file}: ${err.message}`);
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
