/**
 * serviceLoader.js — Auto-discovery and lifecycle management for long-running services.
 *
 * Mirrors the RouteLoader pattern but for persistent services (listeners, pollers, etc.)
 * that feed messages into the system via the message broker.
 *
 * Service contract — each .js file in the services/ directory exports:
 *
 *   module.exports = {
 *     name: 'my-service',               // unique identifier
 *     description: 'What this does',     // human-readable
 *     start(context) {                   // called once on load
 *       // context: { messageBroker, projectManager, agentCLIPool, log, config }
 *       // Set up listeners, connections, polling, etc.
 *       // Return a cleanup function (or nothing)
 *       return () => { // cleanup };
 *     },
 *   };
 *
 * Hot-reload:
 *   Call refresh() to detect added/removed/changed service files.
 *   Removed services are stopped. New/changed services are (re)started.
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a ServiceLoader.
 *
 * @param {string} servicesDir  - Absolute path to services/ directory
 * @param {object} [log]       - Logger with info/warn/error
 * @returns {{ scan, startAll, stopAll, refresh, list }}
 */
function createServiceLoader(servicesDir, log = console) {
  // Running services: name → { module, stopFn, filePath, loadedAt }
  const running = new Map();

  /**
   * Scan the services directory and return discovered service modules.
   */
  function scan() {
    if (!fs.existsSync(servicesDir)) {
      return [];
    }

    const files = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
    const services = [];

    for (const file of files) {
      const filePath = path.join(servicesDir, file);
      try {
        // Clear require cache so changes are picked up
        delete require.cache[require.resolve(filePath)];
        const mod = require(filePath);

        if (!mod.name || typeof mod.start !== 'function') {
          log.warn(`[serviceLoader] Skipping ${file}: missing name or start() function`);
          continue;
        }

        services.push({ ...mod, filePath });
      } catch (err) {
        log.error(`[serviceLoader] Failed to load ${file}: ${err.message}`);
      }
    }

    return services;
  }

  /**
   * Start all discovered services.
   *
   * @param {object} context - Shared context passed to each service's start()
   */
  function startAll(context) {
    const services = scan();

    for (const svc of services) {
      _startService(svc, context);
    }

    log.info(`[serviceLoader] Started ${running.size} service(s): ${[...running.keys()].join(', ') || '(none)'}`);
  }

  /**
   * Start a single service.
   */
  function _startService(svc, context) {
    // Stop existing instance if running
    if (running.has(svc.name)) {
      _stopService(svc.name);
    }

    try {
      const stopFn = svc.start(context);
      running.set(svc.name, {
        module: svc,
        stopFn: typeof stopFn === 'function' ? stopFn : null,
        filePath: svc.filePath,
        loadedAt: Date.now(),
      });
      log.info(`[serviceLoader] Started service: ${svc.name}${svc.description ? ` — ${svc.description}` : ''}`);
    } catch (err) {
      log.error(`[serviceLoader] Failed to start service "${svc.name}": ${err.message}`);
    }
  }

  /**
   * Stop a single service by name.
   */
  function _stopService(name) {
    const entry = running.get(name);
    if (!entry) return;

    try {
      if (entry.stopFn) entry.stopFn();
    } catch (err) {
      log.error(`[serviceLoader] Error stopping service "${name}": ${err.message}`);
    }

    running.delete(name);
    log.info(`[serviceLoader] Stopped service: ${name}`);
  }

  /**
   * Stop all running services.
   */
  function stopAll() {
    for (const name of [...running.keys()]) {
      _stopService(name);
    }
    log.info('[serviceLoader] All services stopped');
  }

  /**
   * Hot-reload: detect added/removed/changed services.
   * Stops removed services, (re)starts new or changed ones.
   *
   * @param {object} context - Shared context for start()
   */
  function refresh(context) {
    const discovered = scan();
    const discoveredNames = new Set(discovered.map(s => s.name));

    // Stop services that are no longer on disk
    for (const name of [...running.keys()]) {
      if (!discoveredNames.has(name)) {
        _stopService(name);
      }
    }

    // Start new or changed services
    for (const svc of discovered) {
      const existing = running.get(svc.name);

      // Check if the file was modified since we loaded it
      if (existing) {
        try {
          const stat = fs.statSync(svc.filePath);
          if (stat.mtimeMs <= existing.loadedAt) {
            continue; // unchanged — skip
          }
        } catch {
          continue;
        }
      }

      _startService(svc, context);
    }
  }

  /**
   * List running services.
   */
  function list() {
    const result = [];
    for (const [name, entry] of running) {
      result.push({
        name,
        description: entry.module.description || '',
        filePath: entry.filePath,
        loadedAt: entry.loadedAt,
        uptimeMs: Date.now() - entry.loadedAt,
      });
    }
    return result;
  }

  return { scan, startAll, stopAll, refresh, list };
}

module.exports = { createServiceLoader };
