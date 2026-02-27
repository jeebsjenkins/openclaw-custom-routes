/**
 * instance-api — Query a customer instance REST API.
 *
 * Uses per-agent secrets (context.agentSecrets) for authentication.
 * The LLM never sees the actual tokens — they're loaded by toolLoader
 * from the agent's secrets.env file at execution time.
 *
 * Required secrets in agent's secrets.env:
 *   INSTANCE_URL=https://api.customer.example.com
 *   INSTANCE_API_TOKEN=Bearer eyJhbG...
 */

const axios = require('axios');

module.exports = {
  name: 'instance-api',
  description: 'Query a customer instance REST API. Supports GET, POST, PUT, DELETE with authenticated requests.',
  schema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        default: 'GET',
        description: 'HTTP method',
      },
      path: {
        type: 'string',
        description: 'API path (e.g. /api/widgets). Will be appended to the instance base URL.',
      },
      query: {
        type: 'object',
        description: 'Query string parameters (key-value pairs)',
      },
      body: {
        type: 'object',
        description: 'Request body (for POST/PUT/PATCH)',
      },
      headers: {
        type: 'object',
        description: 'Additional headers to include in the request',
      },
    },
    required: ['path'],
  },

  async execute(input, context) {
    const { method = 'GET', path: apiPath, query, body, headers: extraHeaders } = input;
    const { agentSecrets = {}, log } = context;

    // Resolve base URL and auth token from agent secrets
    const baseUrl = agentSecrets.INSTANCE_URL || agentSecrets.instance_url;
    const token = agentSecrets.INSTANCE_API_TOKEN || agentSecrets.instance_api_token;

    if (!baseUrl) {
      return {
        output: 'No INSTANCE_URL configured in agent secrets. Add INSTANCE_URL to your secrets.env file.',
        isError: true,
      };
    }

    // Build full URL
    const url = new URL(apiPath, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');

    // Add query parameters
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }

    // Build headers
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extraHeaders,
    };
    if (token) {
      // Support both "Bearer xxx" and raw token formats
      reqHeaders['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    try {
      const response = await axios({
        method: method.toUpperCase(),
        url: url.toString(),
        headers: reqHeaders,
        data: body || undefined,
        timeout: 30000,
        validateStatus: () => true, // Don't throw on non-2xx
      });

      const result = {
        status: response.status,
        statusText: response.statusText,
      };

      // Truncate large responses to avoid overwhelming the LLM context
      const responseData = response.data;
      if (typeof responseData === 'string') {
        result.data = responseData.length > 10000
          ? responseData.slice(0, 10000) + '\n... (truncated)'
          : responseData;
      } else {
        const jsonStr = JSON.stringify(responseData, null, 2);
        result.data = jsonStr.length > 10000
          ? JSON.stringify(responseData).slice(0, 10000) + '\n... (truncated)'
          : responseData;
      }

      const isError = response.status >= 400;

      return {
        output: JSON.stringify(result, null, 2),
        isError,
      };
    } catch (err) {
      if (log) log.error(`[instance-api] ${method} ${url}: ${err.message}`);

      // Provide useful error info without leaking secrets
      const errorInfo = {
        error: err.message,
        method,
        path: apiPath,
        code: err.code || null,
      };

      return {
        output: JSON.stringify(errorInfo, null, 2),
        isError: true,
      };
    }
  },
};
