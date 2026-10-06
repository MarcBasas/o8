import { PLUGIN_PREPARE_TASK_SCOPE } from '@/lib/auth/plugin-token';
import { SEALED_TASK_CONTRACT_INPUT_SCHEMA } from '@/lib/orchestrator/sealed-task-contract';

const string = { type: 'string', minLength: 1, maxLength: 256 };
/** Dormant local schemas. Not part of the production relay/directory manifest. */
export const TASK_DRAFT_TOOLS = [
  {
    name: 'o8_task_options', title: 'Choose an o8 task draft workspace',
    description: 'List registered repository/project choices, then request a fresh clean-workspace snapshot with the selected IDs. Runtime/model entries are catalog metadata; availability is not proven. Does not launch a worker.',
    inputSchema: { type: 'object', properties: { machineId: string, repoId: string, projectId: string },
      required: ['machineId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: 'oauth2', scopes: [PLUGIN_PREPARE_TASK_SCOPE] }],
  },
  {
    name: 'o8_prepare_task', title: 'Prepare a held o8 task draft',
    description: 'Prepare an explicitly requested task draft against a fresh snapshot. Requires exact files, sealed requirements, evidence and runtime/model/effort pins. Reuse idempotencyKey only for an exact retry. The receipt is held and no worker starts; dispatch, approvals, merges and releases are unavailable.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { machineId: string, repoId: string, projectId: string, snapshotId: string, idempotencyKey: string,
        objective: { type: 'string', minLength: 1, maxLength: 2000 },
        allowedFiles: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 240 } },
        runtime: { type: 'string', enum: ['codex', 'claude-code'] }, model: string, effort: string,
        workMode: { type: 'string', enum: ['read-only'] },
        evidence: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 480 } },
        sealedTaskContract: SEALED_TASK_CONTRACT_INPUT_SCHEMA },
      required: ['machineId', 'repoId', 'projectId', 'snapshotId', 'idempotencyKey', 'objective', 'allowedFiles',
        'runtime', 'model', 'effort', 'workMode', 'evidence', 'sealedTaskContract'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: 'oauth2', scopes: [PLUGIN_PREPARE_TASK_SCOPE] }],
  },
] as const;
