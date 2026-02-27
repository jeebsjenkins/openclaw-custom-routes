/**
 * azdo — Azure DevOps work item management.
 *
 * Provides CRUD operations for Azure DevOps work items using the REST API.
 * Authentication uses a Personal Access Token (PAT) from agent secrets.
 *
 * Required secrets in agent's secrets.env:
 *   AZDO_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   AZDO_ORG=yourorg
 *   AZDO_PROJECT=YourProject
 */

const axios = require('axios');

module.exports = {
  name: 'azdo',
  description: 'Azure DevOps work item management. Query, get, update, create work items and add comments.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'get', 'update', 'create', 'add-comment', 'list-comments', 'transitions'],
        description: 'Action to perform',
      },
      workItemId: {
        type: 'number',
        description: 'Work item ID (for get/update/add-comment/list-comments)',
      },
      wiql: {
        type: 'string',
        description: 'WIQL query string (for query action). E.g.: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = \'New\'"',
      },
      fields: {
        type: 'object',
        description: 'Fields to set (for create/update). Keys are field reference names like System.Title, System.State, etc.',
      },
      workItemType: {
        type: 'string',
        description: 'Work item type for create (e.g. "Task", "Bug", "User Story")',
        default: 'Task',
      },
      comment: {
        type: 'string',
        description: 'Comment text (for add-comment action)',
      },
    },
    required: ['action'],
  },

  async execute(input, context) {
    const { action, workItemId, wiql, fields, workItemType = 'Task', comment } = input;
    const { agentSecrets = {}, log } = context;

    const pat = agentSecrets.AZDO_PAT || agentSecrets.azdo_pat;
    const org = agentSecrets.AZDO_ORG || agentSecrets.azdo_org;
    const project = agentSecrets.AZDO_PROJECT || agentSecrets.azdo_project;

    if (!pat || !org) {
      return { output: 'Missing AZDO_PAT and/or AZDO_ORG in agent secrets.', isError: true };
    }

    const baseUrl = `https://dev.azure.com/${org}`;
    const authHeader = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');
    const apiVersion = '7.1';

    const client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json-patch+json',
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    try {
      switch (action) {
        case 'query': {
          if (!wiql) return { output: 'wiql is required for query action', isError: true };
          if (!project) return { output: 'AZDO_PROJECT required for query', isError: true };

          const resp = await client.post(
            `/${project}/_apis/wit/wiql?api-version=${apiVersion}`,
            { query: wiql },
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (resp.status !== 200) {
            return { output: `WIQL query failed (${resp.status}): ${JSON.stringify(resp.data)}`, isError: true };
          }

          const ids = (resp.data.workItems || []).map(wi => wi.id);
          if (ids.length === 0) {
            return { output: JSON.stringify({ count: 0, workItems: [] }, null, 2) };
          }

          // Fetch details for found items (batch, max 200)
          const batchIds = ids.slice(0, 200);
          const detailResp = await client.get(
            `/_apis/wit/workitems?ids=${batchIds.join(',')}&$expand=all&api-version=${apiVersion}`,
            { headers: { 'Content-Type': 'application/json' } }
          );

          const items = (detailResp.data.value || []).map(wi => ({
            id: wi.id,
            title: wi.fields?.['System.Title'],
            state: wi.fields?.['System.State'],
            type: wi.fields?.['System.WorkItemType'],
            assignedTo: wi.fields?.['System.AssignedTo']?.displayName,
            url: wi._links?.html?.href,
          }));

          return { output: JSON.stringify({ count: items.length, total: ids.length, workItems: items }, null, 2) };
        }

        case 'get': {
          if (!workItemId) return { output: 'workItemId is required for get action', isError: true };

          const resp = await client.get(
            `/_apis/wit/workitems/${workItemId}?$expand=all&api-version=${apiVersion}`,
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (resp.status !== 200) {
            return { output: `Get work item failed (${resp.status}): ${JSON.stringify(resp.data)}`, isError: true };
          }

          const f = resp.data.fields || {};
          return {
            output: JSON.stringify({
              id: resp.data.id,
              title: f['System.Title'],
              state: f['System.State'],
              type: f['System.WorkItemType'],
              description: f['System.Description'] || '',
              assignedTo: f['System.AssignedTo']?.displayName,
              createdDate: f['System.CreatedDate'],
              changedDate: f['System.ChangedDate'],
              tags: f['System.Tags'] || '',
              url: resp.data._links?.html?.href,
            }, null, 2),
          };
        }

        case 'update': {
          if (!workItemId) return { output: 'workItemId is required for update action', isError: true };
          if (!fields || Object.keys(fields).length === 0) {
            return { output: 'fields object is required for update action', isError: true };
          }

          // Build JSON Patch document
          const patchDoc = Object.entries(fields).map(([fieldName, value]) => ({
            op: 'replace',
            path: `/fields/${fieldName}`,
            value,
          }));

          const resp = await client.patch(
            `/_apis/wit/workitems/${workItemId}?api-version=${apiVersion}`,
            patchDoc
          );

          if (resp.status !== 200) {
            return { output: `Update failed (${resp.status}): ${JSON.stringify(resp.data)}`, isError: true };
          }

          return {
            output: JSON.stringify({
              success: true,
              id: resp.data.id,
              newState: resp.data.fields?.['System.State'],
              rev: resp.data.rev,
            }, null, 2),
          };
        }

        case 'create': {
          if (!project) return { output: 'AZDO_PROJECT required for create', isError: true };
          if (!fields || !fields['System.Title']) {
            return { output: 'fields.System.Title is required for create action', isError: true };
          }

          const patchDoc = Object.entries(fields).map(([fieldName, value]) => ({
            op: 'add',
            path: `/fields/${fieldName}`,
            value,
          }));

          const encodedType = encodeURIComponent(workItemType);
          const resp = await client.post(
            `/${project}/_apis/wit/workitems/$${encodedType}?api-version=${apiVersion}`,
            patchDoc
          );

          if (resp.status !== 200) {
            return { output: `Create failed (${resp.status}): ${JSON.stringify(resp.data)}`, isError: true };
          }

          return {
            output: JSON.stringify({
              success: true,
              id: resp.data.id,
              title: resp.data.fields?.['System.Title'],
              url: resp.data._links?.html?.href,
            }, null, 2),
          };
        }

        case 'add-comment': {
          if (!workItemId) return { output: 'workItemId required for add-comment', isError: true };
          if (!comment) return { output: 'comment text required for add-comment', isError: true };

          const resp = await client.post(
            `/_apis/wit/workitems/${workItemId}/comments?api-version=${apiVersion}-preview`,
            { text: comment },
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (resp.status !== 200) {
            return { output: `Add comment failed (${resp.status}): ${JSON.stringify(resp.data)}`, isError: true };
          }

          return { output: JSON.stringify({ success: true, commentId: resp.data.id }, null, 2) };
        }

        case 'list-comments': {
          if (!workItemId) return { output: 'workItemId required for list-comments', isError: true };

          const resp = await client.get(
            `/_apis/wit/workitems/${workItemId}/comments?api-version=${apiVersion}-preview`,
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (resp.status !== 200) {
            return { output: `List comments failed (${resp.status})`, isError: true };
          }

          const comments = (resp.data.comments || []).map(c => ({
            id: c.id,
            text: c.text,
            createdBy: c.createdBy?.displayName,
            createdDate: c.createdDate,
          }));

          return { output: JSON.stringify({ count: comments.length, comments }, null, 2) };
        }

        case 'transitions': {
          if (!workItemId) return { output: 'workItemId required for transitions', isError: true };

          // Get work item to find its type, then query allowed transitions
          const wiResp = await client.get(
            `/_apis/wit/workitems/${workItemId}?api-version=${apiVersion}`,
            { headers: { 'Content-Type': 'application/json' } }
          );

          if (wiResp.status !== 200) {
            return { output: `Get work item failed (${wiResp.status})`, isError: true };
          }

          const currentState = wiResp.data.fields?.['System.State'];
          const wiType = wiResp.data.fields?.['System.WorkItemType'];

          return {
            output: JSON.stringify({
              workItemId,
              type: wiType,
              currentState,
              note: 'Use the update action with fields: { "System.State": "NewState" } to transition.',
            }, null, 2),
          };
        }

        default:
          return { output: `Unknown action: ${action}`, isError: true };
      }
    } catch (err) {
      if (log) log.error(`[azdo] ${action} error: ${err.message}`);
      return { output: `Azure DevOps API error: ${err.message}`, isError: true };
    }
  },
};
