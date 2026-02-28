/**
 * service-status — Query the status of running services.
 *
 * Agents use this tool to check on service health, view counters,
 * restart services, or get a full status overview.
 *
 * The serviceLoader is injected into the tool context at startup
 * via the shared `services` property on the tool context.
 */

module.exports = {
  name: 'service-status',
  description: 'Check the status of running services (Slack, etc). List services, get health info, counters, and optionally restart a service.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'status', 'restart', 'stop', 'refresh'],
        description: 'Action: list (all services), status (one service), restart/stop (one service), refresh (hot-reload all)',
        default: 'list',
      },
      service: {
        type: 'string',
        description: 'Service name (required for status/restart/stop)',
      },
    },
  },

  async execute(input, context) {
    const { action = 'list', service } = input;
    const { serviceLoader, log } = context;

    if (!serviceLoader) {
      return {
        output: 'Service loader not available. Make sure the server is configured to pass serviceLoader to the tool context.',
        isError: true,
      };
    }

    try {
      switch (action) {
        case 'list': {
          const services = serviceLoader.list(true); // includeStatus = true
          if (services.length === 0) {
            return { output: 'No services are currently running.' };
          }
          return { output: JSON.stringify(services, null, 2) };
        }

        case 'status': {
          if (!service) {
            // Return all statuses
            const allStatus = serviceLoader.getAllStatus();
            return { output: JSON.stringify(allStatus, null, 2) };
          }
          const status = serviceLoader.getStatus(service);
          if (!status.running) {
            return { output: `Service "${service}" is not running.` };
          }
          return { output: JSON.stringify({ service, ...status }, null, 2) };
        }

        case 'restart': {
          if (!service) {
            return { output: 'Service name required for restart.', isError: true };
          }
          // Refresh will reload the service if its file changed, or restart it
          serviceLoader.refresh(context._serviceContext || {});
          const status = serviceLoader.getStatus(service);
          return {
            output: JSON.stringify({
              action: 'restart',
              service,
              result: status.running ? 'restarted' : 'not found after refresh',
              status,
            }, null, 2),
          };
        }

        case 'stop': {
          if (!service) {
            return { output: 'Service name required for stop.', isError: true };
          }
          // stopAll isn't per-service; we'd need the loader to expose stopService.
          // For now, report that individual stop isn't yet supported.
          return {
            output: `Individual service stop is not yet implemented. Use "refresh" to reload services, or stop the server to stop all services.`,
          };
        }

        case 'refresh': {
          serviceLoader.refresh(context._serviceContext || {});
          const services = serviceLoader.list(true);
          return {
            output: JSON.stringify({
              action: 'refresh',
              servicesAfterRefresh: services,
            }, null, 2),
          };
        }

        default:
          return { output: `Unknown action: ${action}`, isError: true };
      }
    } catch (err) {
      if (log) log.error(`[service-status] Error: ${err.message}`);
      return { output: `Service status error: ${err.message}`, isError: true };
    }
  },
};
